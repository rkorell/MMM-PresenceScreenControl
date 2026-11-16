/**
 * pirLib.js
 * Helper library for PIR sensor access using gpiod CLI tools (gpiomon).
 *
 * Author: Dr. Ralf Korell, 2025
 * Originally from MMM-Pir (bugsounet/Coernel82),
 * updated for gpiomon-based GPIO handling without native Node.js modules.
 *
 * Mode 0: gpiomon (preferred, no native rebuild required)
 * Mode 1: Python/gpiozero fallback (MotionSensor.py)
 *
 * License: MIT
 *
 * Modified: 2026-07-01 19:51 - Set internal pull-down bias for gpiomon/gpioget (libgpiod 2.x) so high-impedance active-high PIR sensors (e.g. Panasonic PaPIR) read a defined LOW at rest (refs #8)
 * Modified: 2026-11-16 12:15 - Logging via injected logger with levels; restart sensor process after unexpected end; stop() always ends child processes; Python stderr no longer marks the sensor as stopped; libgpiod 1.x: pull-down (>= 1.5) and line-buffered output; report failed initial gpioget as unknown; buffer partial gpiomon lines; status for watchdog (refs #12)
 */

const fs = require("fs");
const { execSync, spawn, spawnSync } = require("child_process");

const GPIOGET_TIMEOUT_MS = 2 * 1000;
const RESTART_BACKOFF_MS = [1000, 5000, 30000, 60000];
const RESTART_STABLE_MS = 10 * 60 * 1000;

// Logger interface: error/warn/info/debug(area, msg) and throttle(key, level, area, msg).
// Without an injected logger the library is silent.
const NOOP_LOGGER = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  throttle: () => {}
};

class PIR {
  constructor (config, callback) {
    this.callback = callback;
    this.default = {
      gpio: 21,
      mode: 0,
      debounceMs: 200
    };
    this.config = Object.assign({}, this.default, config);
    this.logger = this.config.logger || NOOP_LOGGER;
    this.pir = null;
    this.gpioMonitor = null;
    this.running = false;
    this.stopping = false;
    this.pirReadyToDetect = false;
    this.restartTimer = null;
    this.restartAttempt = 0;
    this.stableTimer = null;
    this.chip = null;
    this.bias = null;
    this.libgpiod = null;
    this.startedAt = null;
    this.lastRisingAt = null;
    this.lastFallingAt = null;
    this.lastEdge = null;
    this.edgeCount = 0;
    this.stdoutRemainder = "";
  }

  start () {
    if (this.running) return;
    this.stopping = false;
    if (this.config.gpio === 0) {
      this.logger.info("PIR", "Disabled (gpio 0)");
      return;
    }
    switch (this.config.mode) {
      case 0:
        this.logger.info("PIR", "Mode 0 selected (gpiomon CLI)");
        this.gpiodDetect();
        break;
      case 1:
        this.logger.info("PIR", "Mode 1 selected (gpiozero)");
        this.gpiozeroDetect();
        break;
      default:
        this.logger.warn("PIR", `mode ${this.config.mode} is not a valid value, using mode 0`);
        this.config.mode = 0;
        this.gpiodDetect();
        break;
    }
  }

  // Ends every child process regardless of this.running: a sensor process that is still
  // alive must never be left behind (e.g. after Python wrote to stderr).
  stop (reason = "requested") {
    this.stopping = true;
    this.clearRestartTimers();
    const wasRunning = !!(this.gpioMonitor || this.pir);
    if (this.gpioMonitor) {
      const pid = this.gpioMonitor.pid;
      this.gpioMonitor.kill();
      this.gpioMonitor = null;
      this.logger.info("GPIOMON", `Stop (${reason}): gpiomon pid ${pid} terminated`);
    }
    if (this.pir) {
      const pid = this.pir.childProcess ? this.pir.childProcess.pid : "?";
      this.pir.kill();
      this.pir = null;
      this.logger.info("PIR", `Stop (${reason}): Python pid ${pid} terminated`);
    }
    this.running = false;
    if (wasRunning) this.callback("PIR_STOP");
  }

  clearRestartTimers () {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  // Unexpected end of the sensor process: start the same mode again with backoff.
  scheduleRestart () {
    if (this.stopping || this.restartTimer) return;
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
    const delay = RESTART_BACKOFF_MS[Math.min(this.restartAttempt, RESTART_BACKOFF_MS.length - 1)];
    this.restartAttempt++;
    this.logger.warn("PIR", `Restarting sensor process in ${delay / 1000}s (attempt ${this.restartAttempt})`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      if (this.config.mode === 1) this.gpiozeroDetect();
      else this.gpiodDetect();
    }, delay);
  }

  // After a restart: report and reset the backoff once the process has run stably.
  scheduleStableReset () {
    if (this.stableTimer) clearTimeout(this.stableTimer);
    if (this.restartAttempt === 0) return;
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      this.logger.info("PIR", `Sensor process stable for ${RESTART_STABLE_MS / 60000} min after ${this.restartAttempt} restart(s)`);
      this.restartAttempt = 0;
    }, RESTART_STABLE_MS);
  }

  runtimeText () {
    return this.startedAt ? `${Math.round((Date.now() - this.startedAt) / 1000)}s` : "?";
  }

  // Edge bookkeeping shared by gpiomon and gpiozero; a repeated direction means the opposite edge was lost.
  edge (direction) {
    const now = Date.now();
    this.edgeCount++;
    if (direction === "rising") this.lastRisingAt = now;
    else this.lastFallingAt = now;
    if (this.lastEdge === direction) {
      const opposite = direction === "rising" ? "falling" : "rising";
      this.logger.throttle("pir-same-edge", "warn", "PIR", `Two consecutive ${direction} edges — the ${opposite} edge was lost`);
    }
    this.lastEdge = direction;
    this.callback(direction === "rising" ? "PIR_DETECTED" : "PIR_LEFT");
  }

  // Snapshot for the node_helper watchdog and hourly status
  getStatus () {
    const proc = this.gpioMonitor || (this.pir && this.pir.childProcess) || null;
    return {
      mode: this.config.mode,
      running: this.running,
      pid: proc ? proc.pid : null,
      chip: this.chip,
      gpio: this.config.gpio,
      bias: this.bias,
      libgpiod: this.libgpiod,
      startedAt: this.startedAt,
      lastRisingAt: this.lastRisingAt,
      lastFallingAt: this.lastFallingAt,
      edgeCount: this.edgeCount,
      restartAttempt: this.restartAttempt,
      restartPending: !!this.restartTimer
    };
  }

  gpiozeroDetect () {
    const { PythonShell } = require("python-shell");
    let options = {
      mode: "text",
      scriptPath: __dirname,
      pythonOptions: ["-u"],
      args: ["-g", this.config.gpio]
    };

    const pir = new PythonShell("MotionSensor.py", options);
    this.pir = pir;
    this.chip = null;
    this.libgpiod = null;
    // gpiozero MotionSensor uses pull_up=False, i.e. pull-down
    this.bias = "pull-down";
    this.startedAt = Date.now();
    this.lastEdge = null;
    this.callback("PIR_STARTED");
    this.logger.info("PIR", `Started (mode 1, Python/gpiozero, GPIO${this.config.gpio}, pid ${pir.childProcess ? pir.childProcess.pid : "?"})`);
    this.pirReadyToDetect = true;
    this.running = true;
    this.scheduleStableReset();

    pir.on("message", (message) => {
      switch (message) {
        case "Motion":
          if (this.pirReadyToDetect) {
            this.logger.debug("PIR", "Motion detected");
            this.pirReadyToDetect = false;
            this.edge("rising");
          } else {
            this.logger.debug("PIR", "Motion ignored (no NoMotion since the last Motion)");
          }
          break;
        case "NoMotion":
          this.pirReadyToDetect = true;
          // RKORELL: Send PIR_LEFT callback so node_helper can set pirPresence = false.
          // Original MMM-Pir only used PIR_DETECTED; MMM-PresenceScreenControl needs both.
          this.logger.debug("PIR", "No motion, sending PIR_LEFT");
          this.edge("falling");
          break;
        default:
          // MotionSensor.py prints "Error: ..." and exits; the end handler reports the exit.
          this.logger.error("PIR", `[PYTHON] ${message}`);
          this.callback("PIR_ERROR", message);
          break;
      }
    });

    // gpiozero also writes warnings to stderr while the sensor keeps working,
    // so stderr alone does not mean the process has stopped.
    pir.on("stderr", (stderr) => {
      this.logger.throttle("python-stderr", "warn", "PIR", `[PYTHON] stderr: ${stderr}`);
    });

    pir.on("error", (err) => {
      this.logger.error("PIR", `[PYTHON] process error: ${err.message}`);
    });

    pir.end((err, code, signal) => {
      if (this.pir !== pir) {
        this.logger.debug("PIR", `[PYTHON] previous process ended (code ${code}, signal ${signal})`);
        return;
      }
      this.pir = null;
      this.running = false;
      this.logger.error("PIR", `[PYTHON] process ended unexpectedly (code ${code}, signal ${signal}, after ${this.runtimeText()})${err ? ": " + err.message : ""} — no motion events until restart`);
      this.callback("PIR_ERROR", err ? err.message : `exit ${code}`);
      this.scheduleRestart();
    });
  }

  isGpiomonAvailable () {
    if (process.platform !== "linux") {
      this.logger.warn("GPIOMON", "Not running on Linux");
      return false;
    }
    try {
      execSync("which gpiomon", { stdio: "ignore" });
      return true;
    } catch {
      this.logger.warn("GPIOMON", "gpiomon not found. Install gpiod tools (sudo apt install gpiod)");
      return false;
    }
  }

  isCommandAvailable (cmd) {
    try {
      execSync(`which ${cmd}`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  getGpioChip () {
    let model = "";
    try {
      model = fs.readFileSync("/proc/device-tree/model", { encoding: "utf8" });
    } catch {
      // ignore
    }

    if (model.startsWith("Raspberry Pi 5") && fs.existsSync("/dev/gpiochip4")) {
      return "gpiochip4";
    }

    if (fs.existsSync("/dev/gpiochip0")) {
      return "gpiochip0";
    }

    try {
      const chips = fs.readdirSync("/dev").filter((entry) => entry.startsWith("gpiochip")).sort();
      if (chips.length > 0) {
        return chips[0];
      }
    } catch {
      // ignore
    }

    return null;
  }

  // Returns { major, minor }; output format "gpiomon (libgpiod) v2.2.1"
  getGpiomonVersion () {
    try {
      const result = spawnSync("gpiomon", ["--version"], { encoding: "utf8" });
      const output = (result.stdout || "") + (result.stderr || "");
      const match = output.match(/v?(\d+)\.(\d+)/);
      if (match) {
        const version = { major: parseInt(match[1], 10), minor: parseInt(match[2], 10) };
        this.logger.info("GPIOMON", `Detected libgpiod ${version.major}.${version.minor}`);
        return version;
      }
    } catch {
      // ignore
    }
    this.logger.warn("GPIOMON", "Could not detect gpiomon version, assuming 1.0");
    return { major: 1, minor: 0 };
  }

  // gpiomon output can arrive split across chunks: only complete lines are parsed.
  parseGpiomonOutput (data) {
    const text = this.stdoutRemainder + data.toString();
    const lines = text.split("\n");
    this.stdoutRemainder = lines.pop();
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      this.logger.debug("GPIOMON", `output: ${line}`);
      // Use case-insensitive comparison: libgpiod 1.x outputs "RISING EDGE",
      // libgpiod 2.x outputs "rising"
      const lineLower = line.toLowerCase();
      if (lineLower.includes("rising")) {
        this.edge("rising");
      } else if (lineLower.includes("falling")) {
        this.edge("falling");
      } else {
        this.logger.throttle("gpiomon-unknown-line", "error", "GPIOMON", `Unrecognized gpiomon output (neither rising nor falling), event lost: ${line}`);
      }
    }
  }

  gpiodDetect () {
    if (!this.isGpiomonAvailable()) {
      this.logger.warn("GPIOMON", "Falling back to Python/gpiozero (mode 1)");
      this.config.mode = 1;
      this.gpiozeroDetect();
      return;
    }

    const chip = this.getGpioChip();
    if (!chip) {
      this.logger.warn("GPIOMON", "No usable GPIO chip found, falling back to Python/gpiozero (mode 1)");
      this.config.mode = 1;
      this.gpiozeroDetect();
      return;
    }

    const pin = String(this.config.gpio);
    const version = this.getGpiomonVersion();
    const libgpiod = `${version.major}.${version.minor}`;
    let command = "gpiomon";
    let args;
    let getArgs;
    let bias;
    let debounceText = "none";
    if (version.major >= 2) {
      // libgpiod 2.x: gpiomon -c <chip> -p <debounce>ms <line>
      const debounceValue = Number(this.config.debounceMs);
      const debounceMs = Number.isFinite(debounceValue) && debounceValue >= 0
        ? Math.round(debounceValue)
        : 200;
      // The module treats a HIGH line as motion. Some PIR sensors (e.g. Panasonic
      // PaPIR) leave their output high-impedance at rest instead of driving it low,
      // which lets the line float HIGH and report permanent presence. Enable the GPIO's
      // internal pull-down so the line reads a defined LOW when there is no motion.
      // "pull-down" is the value gpiomon expects for -b (alternatives: pull-up, disabled).
      args = ["-c", chip, "-p", `${debounceMs}ms`, "-b", "pull-down", pin];
      // Read the initial state with the same pull-down bias we monitor with,
      // otherwise gpioget would read the default pull-up and report a false initial HIGH.
      getArgs = ["-c", chip, "-b", "pull-down", "--numeric", pin];
      bias = "pull-down";
      debounceText = `${debounceMs}ms`;
    } else {
      // libgpiod 1.x: gpiomon [options] <chip> <line>  (no -c flag, no debounce flag)
      // In 1.x "-b" means --line-buffered (since 1.3) and "-B" sets the bias (since 1.5).
      const options = [];
      if (version.minor >= 3) {
        // Without line buffering gpiomon's stdout to a pipe is block-buffered and events arrive late.
        options.push("-b");
      }
      if (version.minor >= 5) {
        options.push("-B", "pull-down");
        bias = "pull-down";
      } else {
        bias = "as-is";
        this.logger.warn("GPIOMON", `libgpiod ${libgpiod} cannot set a pull-down bias (needs 1.5); a high-impedance sensor output may float. Mode 1 (gpiozero) sets pull-down`);
      }
      args = [...options, chip, pin];
      getArgs = version.minor >= 5 ? ["-B", "pull-down", chip, pin] : [chip, pin];
      if (version.minor < 3) {
        if (this.isCommandAvailable("stdbuf")) {
          command = "stdbuf";
          args = ["-oL", "gpiomon", ...args];
        } else {
          this.logger.warn("GPIOMON", `libgpiod ${libgpiod} has no --line-buffered and stdbuf is missing: motion events may arrive delayed`);
        }
      }
    }
    this.chip = chip;
    this.bias = bias;
    this.libgpiod = libgpiod;
    this.lastEdge = null;
    this.stdoutRemainder = "";

    // Check initial GPIO state before starting edge monitor (Issue #4)
    try {
      const result = spawnSync("gpioget", getArgs, {
        encoding: "utf8",
        timeout: GPIOGET_TIMEOUT_MS
      });
      const initialState = result.status === 0 ? result.stdout.trim() : null;
      if (initialState === "1") {
        this.logger.info("GPIOMON", "Initial GPIO state: HIGH");
        this.lastEdge = "rising";
        this.lastRisingAt = Date.now();
        this.callback("PIR_DETECTED");
      } else if (initialState === "0") {
        this.logger.info("GPIOMON", "Initial GPIO state: LOW");
        this.lastEdge = "falling";
        this.lastFallingAt = Date.now();
        // After a restart the previous presence may be stale
        this.callback("PIR_LEFT");
      } else {
        const why = result.error
          ? result.error.message
          : `exit ${result.status}${result.signal ? ", signal " + result.signal : ""}`;
        const stderr = (result.stderr || "").trim();
        this.logger.warn("GPIOMON", `Initial GPIO state unknown: gpioget ${getArgs.join(" ")} failed (${why})${stderr ? ": " + stderr : ""}${initialState !== null ? ", output: " + initialState : ""}`);
      }
    } catch (err) {
      this.logger.warn("GPIOMON", `Initial GPIO state unknown: gpioget failed: ${err.message}`);
    }

    const monitor = spawn(command, args);
    this.gpioMonitor = monitor;
    this.startedAt = Date.now();
    this.callback("PIR_STARTED");
    this.logger.info("GPIOMON", `Started: ${command} ${args.join(" ")} (libgpiod ${libgpiod}, pid ${monitor.pid}, chip ${chip}, line ${pin}, debounce ${debounceText}, bias ${bias})`);
    this.running = true;
    this.scheduleStableReset();

    monitor.stdout.on("data", (data) => this.parseGpiomonOutput(data));

    // stdout also ends when the process exits; only an end while the process lives is a fault.
    monitor.stdout.on("end", () => {
      setTimeout(() => {
        if (this.gpioMonitor === monitor && monitor.exitCode === null && monitor.signalCode === null) {
          this.logger.error("GPIOMON", `stdout of gpiomon pid ${monitor.pid} closed while the process is still running — no more motion events`);
        }
      }, 1000);
    });

    monitor.stdout.on("error", (err) => {
      this.logger.error("GPIOMON", `stdout error on gpiomon pid ${monitor.pid}: ${err.message} — motion events may be lost`);
    });

    monitor.stderr.on("data", (stderr) => {
      const message = stderr.toString().trim();
      if (message) {
        this.logger.error("GPIOMON", message);
      }
    });

    monitor.on("close", (code, signal) => {
      if (this.gpioMonitor !== monitor) {
        this.logger.debug("GPIOMON", `previous gpiomon pid ${monitor.pid} closed (code ${code}, signal ${signal})`);
        return;
      }
      this.gpioMonitor = null;
      this.running = false;
      if (code !== null && code !== 0) {
        this.logger.warn("GPIOMON", `gpiomon pid ${monitor.pid} exited with code ${code} after ${this.runtimeText()}, falling back to Python/gpiozero (mode 1)`);
        this.config.mode = 1;
        this.gpiozeroDetect();
        return;
      }
      this.logger.error("GPIOMON", `gpiomon pid ${monitor.pid} ended unexpectedly (code ${code}, signal ${signal}, after ${this.runtimeText()}) — no motion events until restart`);
      this.callback("PIR_ERROR", `gpiomon ended (code ${code}, signal ${signal})`);
      this.scheduleRestart();
    });

    monitor.on("error", (err) => {
      if (this.gpioMonitor !== monitor) return;
      this.logger.error("GPIOMON", `Failed to start gpiomon: ${err.message}`);
      this.callback("PIR_ERROR", err.message);
      this.gpioMonitor = null;
      this.running = false;
    });
  }
}

module.exports = PIR;
