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
 */

var log = () => { /* do nothing */ };
const fs = require("fs");
const { execSync, spawn, spawnSync } = require("child_process");

class PIR {
  constructor (config, callback) {
    this.config = config;
    this.callback = callback;
    this.default = {
      debug: false,
      gpio: 21,
      mode: 0,
      debounceMs: 200
    };
    this.config = Object.assign({}, this.default, this.config);
    if (this.config.debug) log = (...args) => { console.log("[MMM-Pir] [LIB] [PIR]", ...args); };
    this.pir = null;
    this.gpioMonitor = null;
    this.running = false;
    this.pirReadyToDetect = false;
  }

  start () {
    if (this.running) return;
    if (this.config.gpio === 0) return console.log("[MMM-Pir] [LIB] [PIR] Disabled.");
    switch (this.config.mode) {
      case 0:
        console.log("[MMM-Pir] [LIB] [PIR] Mode 0 Selected (gpiomon CLI)");
        this.gpiodDetect();
        break;
      case 1:
        console.log("[MMM-Pir] [LIB] [PIR] Mode 1 Selected (gpiozero)");
        this.gpiozeroDetect();
        break;
      default:
        console.warn(`[MMM-Pir] [LIB] [PIR] mode: ${this.config.mode} is not a valid value`);
        console.warn("[MMM-Pir] [LIB] [PIR] set mode 0");
        this.config.mode = 0;
        this.gpiodDetect();
        break;
    }
  }

  stop () {
    if (!this.running) return;
    if (this.gpioMonitor) {
      this.gpioMonitor.kill();
      this.gpioMonitor = null;
    }
    if (this.pir) {
      this.pir.kill();
      this.pir = null;
    }
    this.running = false;
    this.callback("PIR_STOP");
    log("Stop");
  }

  gpiozeroDetect () {
    const { PythonShell } = require("python-shell");
    let options = {
      mode: "text",
      scriptPath: __dirname,
      pythonOptions: ["-u"],
      args: ["-g", this.config.gpio]
    };

    this.pir = new PythonShell("MotionSensor.py", options);
    this.callback("PIR_STARTED");
    console.log("[MMM-Pir] [LIB] [PIR] Started!");
    this.pirReadyToDetect = true;
    this.running = true;

    this.pir.on("message", (message) => {
      switch (message) {
        case "Motion":
          log("Debug: Motion detect ready is", this.pirReadyToDetect);
          if (this.pirReadyToDetect) {
            log("Motion Detected");
            this.callback("PIR_DETECTED");
            this.pirReadyToDetect = false;
            log("Debug: Set motion detect ready to:", this.pirReadyToDetect);
          }
          break;
        case "NoMotion":
          log("No Motion Detected");
          this.pirReadyToDetect = true;
          // RKORELL: Send PIR_LEFT callback so node_helper can set pirPresence = false.
          // Original MMM-Pir only used PIR_DETECTED; MMM-PresenceScreenControl needs both.
          console.log("[PIR] NoMotion event fired, sending PIR_LEFT");
          this.callback("PIR_LEFT");
          log("Debug: Set motion detect ready to:", this.pirReadyToDetect);
          break;
        default:
          console.error("[MMM-Pir] [LIB] [PIR] ", message);
          this.callback("PIR_ERROR", message);
          this.running = false;
          break;
      }
    });

    this.pir.on("stderr", (stderr) => {
      if (this.config.debug) console.error("[MMM-Pir] [LIB] [PIR]", stderr);
      this.running = false;
    });

    this.pir.end((err, code, signal) => {
      if (err) {
        console.error("[MMM-Pir] [LIB] [PIR] [PYTHON]", err);
        this.callback("PIR_ERROR", err.message);
      }
      this.running = false;
      this.pir = null;
      console.warn(`[MMM-Pir] [LIB] [PIR] [PYTHON] The exit code was: ${code}`);
      console.warn(`[MMM-Pir] [LIB] [PIR] [PYTHON] The exit signal was: ${signal}`);
    });
  }

  isGpiomonAvailable () {
    if (process.platform !== "linux") {
      console.warn("[MMM-Pir] [LIB] [PIR] [GPIOMON] Not running on Linux.");
      return false;
    }
    try {
      execSync("which gpiomon", { stdio: "ignore" });
      return true;
    } catch {
      console.warn("[MMM-Pir] [LIB] [PIR] [GPIOMON] gpiomon not found. Install gpiod tools (sudo apt install gpiod).");
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

  getGpiomonVersion () {
    try {
      const result = spawnSync("gpiomon", ["--version"], { encoding: "utf8" });
      const output = (result.stdout || "") + (result.stderr || "");
      const match = output.match(/v?(\d+)\./);
      if (match) {
        const major = parseInt(match[1], 10);
        console.log(`[MMM-Pir] [LIB] [PIR] [GPIOMON] Detected libgpiod major version: ${major}`);
        return major;
      }
    } catch {
      // ignore
    }
    console.warn("[MMM-Pir] [LIB] [PIR] [GPIOMON] Could not detect gpiomon version, assuming 1.x");
    return 1;
  }

  parseGpiomonOutput (data) {
    const lines = data.toString().trim().split("\n");
    for (const line of lines) {
      if (!line) continue;
      log(`gpiomon output: ${line}`);
      // Use case-insensitive comparison: libgpiod 1.x outputs "RISING EDGE",
      // libgpiod 2.x outputs "rising"
      const lineLower = line.toLowerCase();
      if (lineLower.includes("rising")) {
        this.callback("PIR_DETECTED");
      } else if (lineLower.includes("falling")) {
        this.callback("PIR_LEFT");
      }
    }
  }

  gpiodDetect () {
    if (!this.isGpiomonAvailable()) {
      console.log("[MMM-Pir] [LIB] [PIR] [GPIOMON] Falling back to Python/gpiozero (mode 1)");
      this.config.mode = 1;
      this.gpiozeroDetect();
      return;
    }

    const chip = this.getGpioChip();
    if (!chip) {
      console.error("[MMM-Pir] [LIB] [PIR] [GPIOMON] No usable GPIO chip found, falling back to Python/gpiozero.");
      this.config.mode = 1;
      this.gpiozeroDetect();
      return;
    }

    const pin = String(this.config.gpio);
    const version = this.getGpiomonVersion();
    let args;
    if (version >= 2) {
      // libgpiod 2.x: gpiomon -c <chip> -p <debounce>ms <line>
      const debounceValue = Number(this.config.debounceMs);
      const debounceMs = Number.isFinite(debounceValue) && debounceValue >= 0
        ? Math.round(debounceValue)
        : 200;
      args = ["-c", chip, "-p", `${debounceMs}ms`, pin];
      console.log(`[MMM-Pir] [LIB] [PIR] [GPIOMON] Starting gpiomon (libgpiod 2.x) on ${chip} line ${pin} (debounce ${debounceMs}ms)`);
    } else {
      // libgpiod 1.x: gpiomon <chip> <line>  (no -c flag, no debounce flag)
      args = [chip, pin];
      console.log(`[MMM-Pir] [LIB] [PIR] [GPIOMON] Starting gpiomon (libgpiod 1.x) on ${chip} line ${pin}`);
    }
    this.gpioMonitor = spawn("gpiomon", args);
    this.callback("PIR_STARTED");
    console.log("[MMM-Pir] [LIB] [PIR] Started!");
    this.running = true;

    this.gpioMonitor.stdout.on("data", (data) => this.parseGpiomonOutput(data));

    this.gpioMonitor.stderr.on("data", (stderr) => {
      const message = stderr.toString().trim();
      if (message) {
        console.error(`[MMM-Pir] [LIB] [PIR] [GPIOMON] ${message}`);
      }
    });

    this.gpioMonitor.on("close", (code) => {
      if (code !== null && code !== 0 && this.running) {
        console.error(`[MMM-Pir] [LIB] [PIR] [GPIOMON] gpiomon exited with code ${code}, falling back to Python/gpiozero.`);
        this.gpioMonitor = null;
        this.running = false;
        this.config.mode = 1;
        this.gpiozeroDetect();
        return;
      }
      this.gpioMonitor = null;
      this.running = false;
    });

    this.gpioMonitor.on("error", (err) => {
      console.error(`[MMM-Pir] [LIB] [PIR] [GPIOMON] Failed to start gpiomon: ${err.message}`);
      this.callback("PIR_ERROR", err.message);
      this.gpioMonitor = null;
      this.running = false;
    });
  }
}

module.exports = PIR;
