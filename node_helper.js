/**
 * node_helper.js for MMM-PresenceScreenControl
 * Backend logic for presence and screen control using PIR and/or MQTT sensors.
 * Manages timers, cron-based ignore/always-on windows, auto-dimming, and executes user-supplied commands.
 *
 * Author: Dr. Ralf Korell, 2025
 * Integrates logic and ideas from MMM-Pir (bugsounet/Coernel82) and MMM-MQTTScreenOnOff (olexs)
 * License: MIT
 *
 * Modified: 2026-05-05 - Emit screenOn in PRESENCE_UPDATE; trigger update on screen state change (ecoMode support)
 * Modified: 2026-05-05 - Add notification API: WAKEUP/LOCK/UNLOCK/END inputs, presence lock state
 * Modified: 2026-06-06 - Validate autoDimmerOpacity range, warn on startupGracePeriod > counterTimeout
 * Modified: 2026-06-06 - Implement startupGracePeriod as synthetic alwaysOnWindow (fixes #6)
 * Modified: 2026-06-06 - Stop overwriting this.counter while alwaysOn is active (fixes #6 phantom-green-bar)
 * Modified: 2026-06-06 - Seed startup grace before sensor start; suppress counter-loop restart when no countdown remains
 * Modified: 2026-08-18 - Add native Home Assistant MQTT-Discovery switch (dedicated haClient, haPresence source, state/availability topics)
 * Modified: 2026-08-20 - HA: expose PIR/presence as binary_sensor(s) (exposePresence occupancy/motion); switch is now the device main entity (fixes doubled entity_id)
 * Modified: 2026-09-20 19:26 - Credit sensor presence seen during startupGracePeriod to the countdown (startup grace only, not cronAlwaysOnWindows) so short-hold sensors do not blank at grace end (fixes #11)
 * Modified: 2026-09-20 19:37 - updatePresence: use getSensorPresence() instead of a second inline copy of the mode evaluation (no behaviour change)
 * Modified: 2026-11-16 12:20 - Log threshold off/error/warn/info/debug ("off" is silent, simple/complex translated); all log lines re-levelled by severity with area prefixes; startup line, hourly status, PIR pin watchdog (pinctrl), throttling/clock/loop checks; screen command: confirmed state, serial execution, 30s timeout, retry with backoff; validate cron windows (invalid ones crashed the 1s tick); close the old wakeup socket on re-CONFIG; redact credentials in logged config (refs #12)
 */


const NodeHelper = require("node_helper");
const { exec, execFile, spawnSync } = require("child_process");
const mqtt = require("mqtt");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const PIR = require("./pirLib");

const WAKEUP_SOCKET_NAME = "mmm-psc-wakeup.sock";

// --- Logging ---
// "debug" is a threshold: a level shows itself and every more severe level; "off" shows nothing.
const LOG_LEVELS = { off: 0, error: 1, warn: 2, info: 3, debug: 4 };
const LEGACY_DEBUG_LEVELS = { simple: "info", complex: "debug" };
const LOG_THROTTLE_MS = 60 * 60 * 1000;   // repeatable errors: first occurrence, then at most once per hour
const STATUS_INTERVAL_MS = 60 * 60 * 1000;

// --- Screen command ---
const SCREEN_CMD_TIMEOUT_MS = 30 * 1000;
const SCREEN_CMD_SLOW_MS = 2000;
const SCREEN_RETRY_MS = [5000, 30000, 60000];

// --- Watchdog (Raspberry Pi only) ---
const WATCH_INTERVAL_MS = 1000;
const WATCH_CMD_TIMEOUT_MS = 2000;
const WATCH_WINDOW_MS = 5 * 60 * 1000;     // missed HIGH phases are counted within this window
const WATCH_MISSED_PHASES = 3;             // missed HIGH phases within the window -> error
const WATCH_EVENT_SLACK_MS = 2000;         // an edge event may precede/follow the sampled level by this much
const WATCH_LOW_SAMPLES = 3;               // consecutive LOW samples while pirPresence=true -> error
const THROTTLE_CHECK_MS = 60 * 1000;
const NO_COUNTDOWN_GRACE_MS = 3000;
const CHATTER_EDGES_PER_MIN = 30;
const PIR_STUCK_HIGH_MS = 30 * 60 * 1000;
const CLOCK_JUMP_MS = 60 * 1000;
const LOOP_LAG_MS = 2000;

// vcgencmd get_throttled bits
const THROTTLE_BITS = {
  0: "under-voltage now",
  1: "ARM frequency capped now",
  2: "throttled now",
  3: "soft temperature limit now",
  16: "under-voltage occurred",
  17: "ARM frequency capping occurred",
  18: "throttling occurred",
  19: "soft temperature limit occurred"
};

// --- Home Assistant MQTT integration constants ---
const HA_BASE_NS = "magicmirror";          // topic namespace for command/state/availability (distinct from sensor topic)
const HA_CMD_SUFFIX = "/set";
const HA_STATE_SUFFIX = "/state";
const HA_AVAIL_SUFFIX = "/availability";
const HA_PRESENCE_SUFFIX = "/presence";   // occupancy binary_sensor state topic
const HA_MOTION_SUFFIX = "/motion";       // motion binary_sensor state topic
const HA_DEFAULT_OBJECT_ID = "magicmirror_screen";
const HA_DEFAULT_DISCOVERY_PREFIX = "homeassistant";
const HA_PAYLOAD_ON = "ON";
const HA_PAYLOAD_OFF = "OFF";
const HA_AVAIL_ONLINE = "online";
const HA_AVAIL_OFFLINE = "offline";
const HA_RECONNECT_MS = 5000;
const HA_QOS = 1;          // discovery, availability, command-subscribe, LWT
const HA_STATE_QOS = 0;    // state publishes

const VALID_MODES = ["PIR", "MQTT", "PIR_MQTT"];

module.exports = NodeHelper.create({
  start: function () {
    this.presence = false;
    this.counter = 0;
    this.timer = null;
    this.dimmed = false;
    this.alwaysOn = false;
    this.ignoreActive = false;
    this.config = {};
    this.mqttClient = null;
    this.pirInstance = null;
    this.pirPresence = false;
    this.mqttPresence = false;
    this.touchPresence = false;
    this.touchTimer = null;
    this.alwaysOnWindow = null;
    this.cronInterval = null;
    this.prevAlwaysOn = false;
    this.prevIgnoreActive = false;
    this.screenOn = null;          // confirmed state (last successful command)
    this.screenTarget = null;      // requested state
    this.screenReason = null;
    this.screenCmdRunning = false;
    this.screenRetryTimer = null;
    this.screenRetryAttempt = 0;
    this.screenFailures = 0;
    this.screenFirstFailureAt = null;
    this.wakeupServer = null;
    this.wakeupSocketPath = null;
    this.locked = false;
    this.startupGraceExpiry = null;
    this.haClient = null;
    this.haPresence = false;
    this.haTopics = null;
    this.haExpose = null;
    this.haLastPresence = null;
    this.haLastPir = null;
    this.haConnected = false;
    this.haErrorActive = false;
    this.logLevel = 0;
    this.logThrottleState = {};
    this.logStats = { errors: 0, warnings: 0 };
    this.logFileErrorReported = false;
    this.configCount = 0;
    this.mqttConnected = false;
    this.mqttErrorActive = false;
    this.mqttDownSince = null;
    this.mqttLastMessageAt = null;
    this.pirPresenceSince = null;
    this.pirStuckWarned = false;
    this.lastLoggedDimmed = false;
    this.statusTimer = null;
    this.watchTimer = null;
    this.watch = null;
    this.throttleTimer = null;
    this.lastThrottled = null;
    this.lastTick = null;
    this.chatterRef = null;
    this.noCountdownSince = null;
    this.noCountdownActive = false;
    this.edgesAtLastStatus = 0;
  },

  stop: function () {
    this.logAt("info", "STATUS", "Module stopping (MagicMirror shutdown)");
    if (this.timer) clearInterval(this.timer);
    if (this.cronInterval) clearInterval(this.cronInterval);
    if (this.touchTimer) clearTimeout(this.touchTimer);
    this.stopDiagnostics();
    this.clearScreenRetry();
    if (this.pirInstance) {
      this.pirInstance.stop("module stop");
      this.pirInstance = null;
    }
    if (this.mqttClient) {
      try {
        this.mqttClient.end();
      } catch (e) {}
      this.mqttClient = null;
    }
    this.stopHomeAssistant();
    this.stopWakeupListener();
  },

  // --- Logging ---

  resolveLogLevel: function () {
    let level = this.config.debug;
    let legacy = null;
    if (LEGACY_DEBUG_LEVELS[level]) {
      legacy = level;
      level = LEGACY_DEBUG_LEVELS[level];
    }
    this.logLevel = LOG_LEVELS[level] || 0;
    if (legacy) {
      this.logAt("warn", "CONFIG", `debug: "${legacy}" is deprecated, using "${level}" (values: "off", "error", "warn", "info", "debug")`);
    }
  },

  logAt: function (level, area, msg) {
    if (level === "error") this.logStats.errors++;
    else if (level === "warn") this.logStats.warnings++;
    if (!this.logLevel || LOG_LEVELS[level] > this.logLevel) return;
    const line = `[${area}] ${msg}`;
    if (this.config.logFileName) {
      const fileLine = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${line}\n`;
      fs.appendFile(path.join(__dirname, this.config.logFileName), fileLine, err => {
        if (err && !this.logFileErrorReported) {
          this.logFileErrorReported = true;
          console.error(`[LOG] cannot write ${this.config.logFileName}: ${err.message}`);
        }
      });
    } else {
      console[level](line);
    }
    if (level === "debug") {
      this.sendSocketNotification("DEBUG_LOG", line);
    }
  },

  // Repeatable faults: first occurrence, then at most once per LOG_THROTTLE_MS with the suppressed count.
  logThrottled: function (key, level, area, msg) {
    const now = Date.now();
    const state = this.logThrottleState[key] || (this.logThrottleState[key] = { last: 0, suppressed: 0 });
    if (now - state.last < LOG_THROTTLE_MS) {
      state.suppressed++;
      if (level === "error") this.logStats.errors++;
      else if (level === "warn") this.logStats.warnings++;
      return;
    }
    const extra = state.suppressed ? ` (${state.suppressed} more since last report)` : "";
    state.last = now;
    state.suppressed = 0;
    this.logAt(level, area, msg + extra);
  },

  // Logger handed to pirLib
  makePirLogger: function () {
    return {
      error: (area, msg) => this.logAt("error", area, msg),
      warn: (area, msg) => this.logAt("warn", area, msg),
      info: (area, msg) => this.logAt("info", area, msg),
      debug: (area, msg) => this.logAt("debug", area, msg),
      throttle: (key, level, area, msg) => this.logThrottled(key, level, area, msg)
    };
  },

  redactedConfig: function () {
    const copy = Object.assign({}, this.config);
    if (copy.mqttPassword) copy.mqttPassword = "***";
    if (typeof copy.mqttServer === "string") {
      copy.mqttServer = copy.mqttServer.replace(/\/\/([^:@/]+):([^@/]+)@/, "//$1:***@");
    }
    return JSON.stringify(copy);
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "CONFIG") {
      this.config = payload;
      this.configCount++;
      this.resolveLogLevel();
      if (this.configCount > 1) {
        this.logAt("info", "CONFIG", `CONFIG #${this.configCount} received (browser reload or additional client) — restarting sensors`);
      }
      if (this.config.autoDimmer && this.config.autoDimmerTimeout >= this.config.counterTimeout) {
        this.config.autoDimmerTimeout = Math.max(0, this.config.counterTimeout - 1);
        this.logAt("warn", "CONFIG", `autoDimmerTimeout clamped to ${this.config.autoDimmerTimeout} (must be less than counterTimeout ${this.config.counterTimeout})`);
      }
      if (typeof this.config.autoDimmerOpacity !== "number" ||
          this.config.autoDimmerOpacity < 0 || this.config.autoDimmerOpacity > 1) {
        const original = this.config.autoDimmerOpacity;
        const clamped = Math.min(1, Math.max(0, Number(original) || 0.2));
        this.logAt("warn", "CONFIG", `autoDimmerOpacity ${original} out of range [0,1], clamped to ${clamped}`);
        this.config.autoDimmerOpacity = clamped;
      }
      this.logAt("info", "CONFIG", `CONFIG #${this.configCount}: ${this.redactedConfig()}`);
      this.validateConfig();
      if (this.configCount === 1) this.logStartup();
      // Seed startup grace state BEFORE sensor/cron start so async sensor init events
      // (e.g. PIR initial-state read) see the correct alwaysOn=true and route accordingly.
      if (this.config.startupGracePeriod > 0) {
        this.startupGraceExpiry = Date.now() + this.config.startupGracePeriod * 1000;
        this.alwaysOn = true;
        this.alwaysOnWindow = {
          from: "startup",
          to: "startup",
          total: this.config.startupGracePeriod,
          left: this.config.startupGracePeriod
        };
        this.prevAlwaysOn = true;
        this.logAt("info", "CRON", `startupGracePeriod active (${this.config.startupGracePeriod}s)`);
      }
      if (this.config.mode === "PIR" || this.config.mode === "PIR_MQTT") {
        this.startPirSensor();
      }
      if (this.config.mode === "MQTT" || this.config.mode === "PIR_MQTT") {
        this.startMqtt();
      }
      this.startCronMonitor();
      if (this.config.homeAssistant && this.config.homeAssistant.enabled) {
        this.startHomeAssistant();
      }
      this.stopWakeupListener();
      if (this.config.treatExternalWakeupAsPresence) {
        this.startWakeupListener();
      }
      this.startDiagnostics();
      this.updatePresence();
    } else if (notification === "TOUCH_EVENT") {
      this.handleTouch(payload);
    } else if (notification === "EXT_WAKEUP") {
      this.triggerPresence(`notification WAKEUP from ${this.senderName(payload)}`);
    } else if (notification === "EXT_END") {
      this.logAt("info", "INPUT", `Notification END from ${this.senderName(payload)} (force screen off)`);
      this.forceScreenOff();
    } else if (notification === "EXT_LOCK") {
      this.logAt("info", "INPUT", `Notification LOCK from ${this.senderName(payload)}`);
      this.locked = true;
      this.sendPresenceUpdate();
    } else if (notification === "EXT_UNLOCK") {
      this.logAt("info", "INPUT", `Notification UNLOCK from ${this.senderName(payload)}`);
      this.locked = false;
      this.updatePresence();
    } else {
      this.logAt("debug", "INPUT", `Unknown socket notification: ${notification}`);
    }
  },

  senderName: function (payload) {
    return (payload && payload.sender) || "unknown";
  },

  // --- Config checks (log points for silent misconfiguration) ---

  validateConfig: function () {
    if (!VALID_MODES.includes(this.config.mode)) {
      this.logAt("error", "CONFIG", `mode "${this.config.mode}" is not valid (${VALID_MODES.join(", ")}) — no sensor is started`);
    }
    if (!this.config.onCommand) {
      this.logAt("warn", "CONFIG", "onCommand is empty — the screen is never switched on by this module");
    }
    if (!this.config.offCommand) {
      this.logAt("warn", "CONFIG", "offCommand is empty — the screen is never switched off by this module");
    }
    if (this.config.mqttPayloadOn && this.config.mqttPayloadOccupancyField && this.config.mqttPayloadOccupancyField !== "presence") {
      this.logAt("warn", "MQTT", "mqttPayloadOccupancyField is ignored in bare-string mode (mqttPayloadOn is set)");
    }
    this.config.cronAlwaysOnWindows = this.validWindows(this.config.cronAlwaysOnWindows, "cronAlwaysOnWindows");
    this.config.cronIgnoreWindows = this.validWindows(this.config.cronIgnoreWindows, "cronIgnoreWindows");
    this.reportWindowOverlap();
  },

  isValidTime: function (t) {
    return typeof t === "string" && (/^([01]?\d|2[0-3]):[0-5]\d$/.test(t) || t === "24:00");
  },

  // Invalid windows would throw inside the 1s cron tick (or never match); they are dropped.
  validWindows: function (windows, name) {
    if (windows === undefined || windows === null) return [];
    if (!Array.isArray(windows)) {
      this.logAt("warn", "CRON", `${name} is not an array — ignored`);
      return [];
    }
    return windows.filter((window, i) => {
      const problems = [];
      if (!window || typeof window !== "object") {
        problems.push("not an object");
      } else {
        if (!this.isValidTime(window.from)) problems.push(`from "${window.from}" is not HH:MM`);
        if (!this.isValidTime(window.to)) problems.push(`to "${window.to}" is not HH:MM`);
        if (window.days !== undefined && !(Array.isArray(window.days) &&
            window.days.every(d => Number.isInteger(d) && d >= 0 && d <= 6))) {
          problems.push(`days ${JSON.stringify(window.days)} must be an array of 0-6`);
        }
      }
      if (problems.length) {
        this.logAt("warn", "CRON", `${name}[${i}] ignored: ${problems.join(", ")}`);
        return false;
      }
      return true;
    });
  },

  windowActiveAt: function (window, day, minutes) {
    if (window.days && !window.days.includes(day)) return false;
    const [fromH, fromM] = window.from.split(":").map(Number);
    const [toH, toM] = window.to.split(":").map(Number);
    const fromMinutes = fromH * 60 + fromM;
    const toMinutes = toH * 60 + toM;
    if (fromMinutes <= toMinutes) {
      return minutes >= fromMinutes && minutes < toMinutes;
    }
    return minutes >= fromMinutes || minutes < toMinutes;
  },

  // alwaysOn wins over ignore (startCronMonitor); an overlap is legal but often unintended.
  reportWindowOverlap: function () {
    const alwaysOn = this.config.cronAlwaysOnWindows;
    const ignore = this.config.cronIgnoreWindows;
    if (!alwaysOn.length || !ignore.length) return;
    let overlapMinutes = 0;
    for (let day = 0; day < 7; day++) {
      for (let minute = 0; minute < 1440; minute++) {
        if (alwaysOn.some(w => this.windowActiveAt(w, day, minute)) &&
            ignore.some(w => this.windowActiveAt(w, day, minute))) {
          overlapMinutes++;
        }
      }
    }
    if (overlapMinutes > 0) {
      this.logAt("info", "CRON", `cronAlwaysOnWindows and cronIgnoreWindows overlap for ${overlapMinutes} min per week — alwaysOn wins there`);
    }
  },

  // --- Startup line, hourly status, watchdog ---

  commandAvailable: function (cmd) {
    try {
      return spawnSync("which", [cmd], { stdio: "ignore" }).status === 0;
    } catch (e) {
      return false;
    }
  },

  readPiModel: function () {
    try {
      return fs.readFileSync("/proc/device-tree/model", { encoding: "utf8" }).replace(/\0/g, "").trim();
    } catch (e) {
      return "";
    }
  },

  logStartup: function () {
    let pscVersion = "?";
    try {
      pscVersion = require("./package.json").version;
    } catch (e) {}
    this.piModel = this.readPiModel();
    this.hasPinctrl = this.commandAvailable("pinctrl");
    this.hasVcgencmd = this.commandAvailable("vcgencmd");
    const c = this.config;
    this.logAt("info", "STATUS",
      `Startup: PSC ${pscVersion}, MagicMirror ${global.version || "?"}, Node ${process.version}, ` +
      `kernel ${os.release()}, model "${this.piModel || "unknown"}", pinctrl ${this.hasPinctrl ? "yes" : "no"}, ` +
      `vcgencmd ${this.hasVcgencmd ? "yes" : "no"} | mode ${c.mode}, pirGPIO ${c.pirGPIO}, counterTimeout ${c.counterTimeout}s, ` +
      `startupGracePeriod ${c.startupGracePeriod || 0}s, autoDimmer ${c.autoDimmer ? c.autoDimmerTimeout + "s" : "off"}, ` +
      `alwaysOn windows ${(c.cronAlwaysOnWindows || []).length}, ignore windows ${(c.cronIgnoreWindows || []).length}, ` +
      `HA ${c.homeAssistant && c.homeAssistant.enabled ? "on" : "off"}, wakeup socket ${c.treatExternalWakeupAsPresence ? "on" : "off"}`);
  },

  startDiagnostics: function () {
    this.stopDiagnostics();
    // Pending pinctrl/vcgencmd callbacks of an older generation must not reschedule themselves
    this.diagGeneration = (this.diagGeneration || 0) + 1;
    // Diagnostics only produce log lines; with "off" they would just cost a pinctrl call per second
    if (!this.logLevel) return;
    if (this.piModel === undefined) {
      this.piModel = this.readPiModel();
      this.hasPinctrl = this.commandAvailable("pinctrl");
      this.hasVcgencmd = this.commandAvailable("vcgencmd");
    }
    const isPi = this.piModel.startsWith("Raspberry Pi");
    this.statusTimer = setTimeout(() => this.logStatus(), STATUS_INTERVAL_MS);
    if (isPi && this.pirInstance) {
      if (this.hasPinctrl) {
        this.watch = {
          lastLevel: null,
          phaseStart: null,
          phaseEvaluated: false,
          missed: [],
          missedActive: false,
          lowSamples: 0,
          lowStuckActive: false,
          configActive: false,
          configSince: null,
          pidDeadActive: false,
          level: null,
          bias: null,
          func: null
        };
        this.scheduleWatch();
      } else {
        this.logAt("warn", "WATCH", "pinctrl not found — PIR pin watchdog disabled");
      }
    }
    if (isPi && this.hasVcgencmd) {
      this.checkThrottled();
    }
  },

  stopDiagnostics: function () {
    if (this.statusTimer) clearTimeout(this.statusTimer);
    if (this.watchTimer) clearTimeout(this.watchTimer);
    if (this.throttleTimer) clearTimeout(this.throttleTimer);
    this.statusTimer = null;
    this.watchTimer = null;
    this.throttleTimer = null;
    this.watch = null;
    this.diagGeneration = (this.diagGeneration || 0) + 1;
  },

  scheduleWatch: function () {
    this.watchTimer = setTimeout(() => this.watchPin(), WATCH_INTERVAL_MS);
  },

  // Independent check of the PIR line: reads level/function/bias with pinctrl and compares
  // them with the events gpiomon/gpiozero delivered.
  watchPin: function () {
    this.watchTimer = null;
    if (!this.watch || !this.pirInstance) return;
    const gpio = String(this.config.pirGPIO || 4);
    const generation = this.diagGeneration;
    execFile("pinctrl", ["get", gpio], { timeout: WATCH_CMD_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (!this.watch || generation !== this.diagGeneration) return;
      if (err) {
        this.logThrottled("watch-pinctrl", "warn", "WATCH", `pinctrl get ${gpio} failed: ${err.message}${stderr ? " " + stderr.trim() : ""}`);
      } else {
        // e.g. " 4: ip    pd | lo // GPIO4 = input"
        const m = stdout.match(/^\s*\d+:\s*(\S+)\s+(?:(pu|pd|pn)\s+)?\|\s*(hi|lo|--)/);
        if (m) {
          this.evaluatePin(m[1], m[2] || "none", m[3]);
        } else {
          this.logThrottled("watch-parse", "warn", "WATCH", `Unrecognized pinctrl output: ${stdout.trim()}`);
        }
      }
      this.scheduleWatch();
    });
  },

  evaluatePin: function (func, bias, level) {
    const w = this.watch;
    const now = Date.now();
    const st = this.pirInstance.getStatus();
    w.level = level;
    w.bias = bias;
    w.func = func;
    if (!st.running) {
      // Restart pending or sensor stopped: pirLib reports that itself; reset phase tracking.
      w.lastLevel = null;
      w.phaseStart = null;
      w.lowSamples = 0;
      return;
    }

    // Monitor process alive?
    let alive = true;
    if (st.pid) {
      try { process.kill(st.pid, 0); } catch (e) { alive = (e.code === "EPERM"); }
    }
    if (!alive && !w.pidDeadActive) {
      w.pidDeadActive = true;
      this.logAt("error", "WATCH", `Sensor process pid ${st.pid} is gone but no exit was reported — no motion events`);
    } else if (alive && w.pidDeadActive) {
      w.pidDeadActive = false;
      this.logAt("info", "WATCH", `Sensor process pid ${st.pid} alive again`);
    }

    // Pin configuration: input with pull-down (unless the libgpiod version cannot set a bias)
    const expectBias = st.bias === "pull-down";
    const configOk = func === "ip" && (!expectBias || bias === "pd");
    if (!configOk && !w.configActive) {
      w.configActive = true;
      w.configSince = now;
      this.logAt("error", "WATCH", `GPIO${st.gpio} configuration changed: function ${func}, bias ${bias} (expected ip${expectBias ? ", pd" : ""}) — readings and events are unreliable`);
    } else if (configOk && w.configActive) {
      w.configActive = false;
      this.logAt("info", "WATCH", `GPIO${st.gpio} configuration back to ${func}/${bias} after ${Math.round((now - w.configSince) / 1000)}s`);
    }

    if (level !== "hi" && level !== "lo") return;

    // HIGH phases without a rising event
    if (level === "hi") {
      if (w.lastLevel !== "hi") {
        w.phaseStart = now;
        w.phaseEvaluated = false;
      } else if (!w.phaseEvaluated && now - w.phaseStart >= 2 * WATCH_INTERVAL_MS) {
        this.evaluateHighPhase(st, now);
      }
    } else if (w.lastLevel === "hi" && !w.phaseEvaluated) {
      this.evaluateHighPhase(st, now);
    }

    // LOW while pirPresence=true without a falling event
    if (level === "lo" && this.pirPresence) {
      w.lowSamples++;
      if (w.lowSamples >= WATCH_LOW_SAMPLES && !w.lowStuckActive) {
        w.lowStuckActive = true;
        this.logAt("error", "WATCH", `GPIO${st.gpio} is LOW for ${w.lowSamples}s but no falling event arrived — PIR presence stuck`);
      }
    } else {
      w.lowSamples = 0;
      if (w.lowStuckActive) {
        w.lowStuckActive = false;
        this.logAt("info", "WATCH", `PIR presence stuck state cleared (level ${level}, pirPresence ${this.pirPresence})`);
      }
    }
    w.lastLevel = level;
  },

  evaluateHighPhase: function (st, now) {
    const w = this.watch;
    w.phaseEvaluated = true;
    const seen = st.lastRisingAt && st.lastRisingAt >= w.phaseStart - WATCH_EVENT_SLACK_MS;
    if (seen) {
      if (w.missedActive) {
        w.missedActive = false;
        this.logAt("info", "WATCH", `Rising events match the pin level again (GPIO${st.gpio})`);
      }
      w.missed = [];
      return;
    }
    w.missed = w.missed.filter(t => now - t < WATCH_WINDOW_MS);
    w.missed.push(now);
    this.logAt("debug", "WATCH", `GPIO${st.gpio} was HIGH (since ${Math.round((now - w.phaseStart) / 1000)}s) without a rising event`);
    if (w.missed.length >= WATCH_MISSED_PHASES && !w.missedActive) {
      w.missedActive = true;
      this.logAt("error", "WATCH", `GPIO${st.gpio} went HIGH ${w.missed.length} times in ${WATCH_WINDOW_MS / 60000} min without a rising event — motion is not detected (sensor process pid ${st.pid}, libgpiod ${st.libgpiod || "-"}, bias ${st.bias})`);
    }
  },

  checkThrottled: function () {
    this.throttleTimer = null;
    const generation = this.diagGeneration;
    execFile("vcgencmd", ["get_throttled"], { timeout: 5000 }, (err, stdout) => {
      if (generation !== this.diagGeneration) return;
      if (!err) {
        const m = stdout.match(/throttled=(0x[0-9a-fA-F]+)/);
        if (m && m[1] !== this.lastThrottled) {
          const value = parseInt(m[1], 16);
          if (value !== 0) {
            const flags = Object.keys(THROTTLE_BITS).filter(bit => value & (1 << bit)).map(bit => THROTTLE_BITS[bit]);
            this.logAt("warn", "STATUS", `vcgencmd get_throttled=${m[1]}: ${flags.join(", ") || "unknown bits"} — check the power supply`);
          } else if (this.lastThrottled !== null) {
            this.logAt("info", "STATUS", "vcgencmd get_throttled=0x0");
          }
          this.lastThrottled = m[1];
        }
      }
      this.throttleTimer = setTimeout(() => this.checkThrottled(), THROTTLE_CHECK_MS);
    });
  },

  ageText: function (t) {
    if (!t) return "never";
    const s = Math.round((Date.now() - t) / 1000);
    return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s ago` : `${s}s ago`;
  },

  logStatus: function () {
    this.statusTimer = setTimeout(() => this.logStatus(), STATUS_INTERVAL_MS);
    const parts = [`mode ${this.config.mode}`];
    if (this.pirInstance) {
      const st = this.pirInstance.getStatus();
      let alive = false;
      if (st.pid) {
        try { process.kill(st.pid, 0); alive = true; } catch (e) { alive = (e.code === "EPERM"); }
      }
      const edges = st.edgeCount - this.edgesAtLastStatus;
      this.edgesAtLastStatus = st.edgeCount;
      const pin = this.watch && this.watch.level ? `, pin ${this.watch.level}/${this.watch.bias}` : "";
      parts.push(`PIR ${st.mode === 1 ? "gpiozero" : "gpiomon " + (st.libgpiod || "?")} pid ${st.pid || "-"} ${alive ? "alive" : "NOT running"}${pin}, edges ${edges}/h, last rising ${this.ageText(st.lastRisingAt)}, restarts ${st.restartAttempt}`);
    }
    parts.push(`presence ${this.presence}, pir ${this.pirPresence}, mqtt ${this.mqttPresence}, screenOn ${this.screenOn}, target ${this.screenTarget}, counter ${this.counter}, locked ${this.locked}, alwaysOn ${this.alwaysOn}, ignore ${this.ignoreActive}`);
    if (this.mqttClient) {
      parts.push(`MQTT ${this.mqttConnected ? "connected" : "DISCONNECTED"}, last message ${this.ageText(this.mqttLastMessageAt)}`);
    }
    if (this.haClient) {
      parts.push(`HA ${this.haConnected ? "connected" : "DISCONNECTED"}`);
    }
    parts.push(`errors ${this.logStats.errors}, warnings ${this.logStats.warnings} in the last hour`);
    if (this.lastThrottled) parts.push(`throttled=${this.lastThrottled}`);
    parts.push(`rss ${Math.round(process.memoryUsage().rss / 1048576)} MB`);
    this.logStats = { errors: 0, warnings: 0 };
    this.logAt("info", "STATUS", "Hourly: " + parts.join(" | "));
  },

  // Runs from the 1s cron tick
  checkRuntime: function () {
    const now = Date.now();
    const mono = Number(process.hrtime.bigint() / 1000000n);
    if (this.lastTick) {
      const dMono = mono - this.lastTick.mono;
      const dWall = now - this.lastTick.wall;
      if (Math.abs(dWall - dMono) > CLOCK_JUMP_MS) {
        this.logAt("warn", "STATUS", `System clock jumped by ${Math.round((dWall - dMono) / 1000)}s — cron windows and timers may shift`);
      }
      if (dMono - 1000 > LOOP_LAG_MS) {
        this.logThrottled("loop-lag", "warn", "STATUS", `Event loop stalled: 1s tick came ${dMono - 1000} ms late`);
      }
    }
    this.lastTick = { mono: mono, wall: now };

    // Screen on, but nothing will ever turn it off
    const noCountdown = this.screenOn === true && this.screenTarget === true && !this.alwaysOn &&
      !this.timer && !this.presence && !this.locked;
    if (noCountdown) {
      if (!this.noCountdownSince) this.noCountdownSince = now;
      if (!this.noCountdownActive && now - this.noCountdownSince >= NO_COUNTDOWN_GRACE_MS) {
        this.noCountdownActive = true;
        this.logAt("error", "PRESENCE", "Screen is on without countdown, presence or alwaysOn — it will not turn off");
      }
    } else {
      this.noCountdownSince = null;
      if (this.noCountdownActive) {
        this.noCountdownActive = false;
        this.logAt("info", "PRESENCE", "Screen countdown state consistent again");
      }
    }

    if (this.pirInstance) {
      const edges = this.pirInstance.getStatus().edgeCount;
      if (!this.chatterRef) this.chatterRef = { t: now, edges: edges };
      if (now - this.chatterRef.t >= 60000) {
        const delta = edges - this.chatterRef.edges;
        if (delta > CHATTER_EDGES_PER_MIN) {
          this.logThrottled("pir-chatter", "warn", "PIR", `${delta} edges in the last minute — sensor output is chattering (wiring, supply or interference)`);
        }
        this.chatterRef = { t: now, edges: edges };
      }
      if (this.pirPresence && this.pirPresenceSince && !this.pirStuckWarned && now - this.pirPresenceSince > PIR_STUCK_HIGH_MS) {
        this.pirStuckWarned = true;
        this.logAt("warn", "PIR", `PIR reports presence continuously for ${Math.round((now - this.pirPresenceSince) / 60000)} min`);
      }
    }
  },

  forceScreenOff: function () {
    this.presence = false;
    this.touchPresence = false;
    this.counter = 0;
    this.dimmed = false;
    this.updateScreen(false, "end");
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.sendPresenceUpdate();
  },

  handleTouch: function (payload) {
    this.triggerPresence((payload && payload.type) || "click");
  },

  triggerPresence: function (source) {
    this.logAt("info", "INPUT", `Touch/wakeup (${source}): triggering presence`);
    if (this.locked) {
      this.logAt("debug", "INPUT", `${source} has no effect: presence is locked`);
    } else if (this.ignoreActive) {
      this.logAt("debug", "INPUT", `${source} has no effect: ignore window active`);
    }
    // RKORELL: Touch setzt touchPresence, nicht presence direkt.
    // Nach 100ms wird touchPresence zurückgesetzt → Counter zählt runter.
    // Wenn PIR/MQTT aktiv wird, übernimmt das und nullt touchPresence.
    this.touchPresence = true;
    if (this.touchTimer) clearTimeout(this.touchTimer);
    this.updatePresence();

    this.touchTimer = setTimeout(() => {
      this.touchPresence = false;
      this.touchTimer = null;
      this.updatePresence();
    }, 100);
  },

  startWakeupListener: function () {
    this.stopWakeupListener();
    const runtimeDir = process.env.XDG_RUNTIME_DIR || "/tmp";
    this.wakeupSocketPath = path.join(runtimeDir, WAKEUP_SOCKET_NAME);
    try { fs.unlinkSync(this.wakeupSocketPath); } catch (e) {}
    this.wakeupServer = net.createServer((conn) => {
      conn.on("data", () => {
        this.triggerPresence("wakeup socket");
        conn.end();
      });
      conn.on("error", () => {});
    });
    this.wakeupServer.on("error", (err) => {
      this.logAt("error", "INPUT", `Wakeup socket ${this.wakeupSocketPath} error: ${err.message} — external wakeups are not received`);
    });
    this.wakeupServer.listen(this.wakeupSocketPath, () => {
      this.logAt("info", "INPUT", "Wakeup socket listening on " + this.wakeupSocketPath);
    });
  },

  stopWakeupListener: function () {
    if (this.wakeupServer) {
      try { this.wakeupServer.close(); } catch (e) {}
      this.wakeupServer = null;
    }
    if (this.wakeupSocketPath) {
      try { fs.unlinkSync(this.wakeupSocketPath); } catch (e) {}
      this.wakeupSocketPath = null;
    }
  },

  // PRÄMISSENTREU: PIR-Integration mit eigenem State
  startPirSensor: function () {
    if (this.pirInstance) this.pirInstance.stop("re-CONFIG");
    this.edgesAtLastStatus = 0;
    this.chatterRef = null;
    this.pirInstance = new PIR(
      {
        gpio: this.config.pirGPIO || 4,
        mode: 0,
        logger: this.makePirLogger()
      },
      (event, data) => {
        if (event === "PIR_DETECTED") {
          this.logAt("debug", "PIR", "PIR_DETECTED received");
          if (!this.pirPresence) {
            this.pirPresenceSince = Date.now();
            this.pirStuckWarned = false;
          }
          this.pirPresence = true;
          // RKORELL: Touch-Mechanismus nullen wenn echte Präsenz erkannt
          this.touchPresence = false;
          if (this.touchTimer) {
            clearTimeout(this.touchTimer);
            this.touchTimer = null;
          }
        } else if (event === "PIR_LEFT") {
          this.logAt("debug", "PIR", "PIR_LEFT received, setting pirPresence=false");
          this.pirPresence = false;
          this.pirPresenceSince = null;
        }
        this.updatePresence();
      }
    );
    this.pirInstance.start();
  },

  startMqtt: function () {
    if (this.mqttClient) {
      try { this.mqttClient.end(); } catch (e) {}
    }
    var mqttOptions = {};
    if (this.config.mqttUser) { mqttOptions.username = this.config.mqttUser; }
    if (this.config.mqttPassword) { mqttOptions.password = this.config.mqttPassword; }
    this.mqttConnected = false;
    this.mqttErrorActive = false;
    const client = mqtt.connect(this.config.mqttServer, mqttOptions);
    this.mqttClient = client;
    client.on("connect", () => {
      if (this.mqttClient !== client) return;
      this.mqttConnected = true;
      if (this.mqttErrorActive) {
        this.mqttErrorActive = false;
        this.logAt("info", "MQTT", `Connected to ${this.redactedServer()} after ${Math.round((Date.now() - this.mqttDownSince) / 1000)}s without connection`);
      } else {
        this.logAt("info", "MQTT", "Connected to " + this.redactedServer());
      }
      client.subscribe(this.config.mqttTopic, (err) => {
        if (err) this.logAt("error", "MQTT", `Subscribe to ${this.config.mqttTopic} failed: ${err} — no MQTT presence`);
        else this.logAt("info", "MQTT", "Subscribed to topic: " + this.config.mqttTopic);
      });
    });
    client.on("message", (topic, message) => {
      const raw = message.toString();
      const bareMode = !!this.config.mqttPayloadOn;
      let presence;
      this.mqttLastMessageAt = Date.now();

      if (bareMode) {
        presence = (raw.trim() === this.config.mqttPayloadOn);
      } else {
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch (e) {
          this.logThrottled("mqtt-json", "error", "MQTT", `Field mode JSON parse error: ${e} — payload: ${raw}`);
          return;
        }
        const field = this.config.mqttPayloadOccupancyField || "presence";
        if (!payload || typeof payload !== "object" || !(field in payload)) {
          this.logThrottled("mqtt-field", "error", "MQTT", `Field "${field}" missing in payload — treated as no presence: ${raw}`);
        }
        presence = this.coercePresence(payload && payload[field]);
      }

      this.logAt("debug", "MQTT", `received (${bareMode ? "bare" : "field"} mode): mqttPresence=${presence}`);
      this.mqttPresence = presence;
      // RKORELL: Touch-Mechanismus nullen wenn echte Präsenz erkannt
      if (presence) {
        this.touchPresence = false;
        if (this.touchTimer) {
          clearTimeout(this.touchTimer);
          this.touchTimer = null;
        }
      }
      this.updatePresence();
    });
    client.on("error", (err) => {
      if (this.mqttClient !== client) return;
      if (!this.mqttErrorActive) {
        this.mqttErrorActive = true;
        this.mqttDownSince = Date.now();
        this.logAt("error", "MQTT", `Connection error: ${err.message || err} — no MQTT presence until reconnected`);
      } else {
        this.logAt("debug", "MQTT", `Connection error (repeated): ${err.message || err}`);
      }
    });
    // "close" also follows every failed (re)connect attempt
    client.on("close", () => {
      if (this.mqttClient !== client) return;
      if (!this.mqttErrorActive) {
        this.mqttErrorActive = true;
        this.mqttDownSince = Date.now();
        this.logAt("error", "MQTT", this.mqttConnected
          ? "Connection closed — no MQTT presence until reconnected"
          : `Cannot connect to ${this.redactedServer()} — no MQTT presence until connected`);
      }
      this.mqttConnected = false;
    });
  },

  redactedServer: function () {
    return String(this.config.mqttServer).replace(/\/\/([^:@/]+):([^@/]+)@/, "//$1:***@");
  },

  coercePresence: function (v) {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") {
      const s = v.toLowerCase().trim();
      return s === "true" || s === "1" || s === "on" || s === "yes";
    }
    return false;
  },

  // Sensor-presence according to the configured mode, plus the mode-independent
  // sources (touch, Home Assistant). Mirrors the evaluation used by updatePresence().
  getSensorPresence: function () {
    let sensorPresence = false;
    if (this.config.mode === "PIR_MQTT") {
      sensorPresence = (this.pirPresence || this.mqttPresence);
    } else if (this.config.mode === "PIR") {
      sensorPresence = this.pirPresence;
    } else if (this.config.mode === "MQTT") {
      sensorPresence = this.mqttPresence;
    }
    return sensorPresence || this.touchPresence || this.haPresence;
  },

  // Names the active presence sources for the screen log line
  presenceSources: function () {
    const sources = [];
    if (this.pirPresence && (this.config.mode === "PIR" || this.config.mode === "PIR_MQTT")) sources.push("pir");
    if (this.mqttPresence && (this.config.mode === "MQTT" || this.config.mode === "PIR_MQTT")) sources.push("mqtt");
    if (this.touchPresence) sources.push("touch");
    if (this.haPresence) sources.push("ha");
    return sources.join("+") || "presence";
  },

  // PRÄMISSENTREU: State-Decision je nach Mode
  updatePresence: function () {
    this.logAt("debug", "PRESENCE", `updatePresence: pirPresence=${this.pirPresence}, mqttPresence=${this.mqttPresence}, touchPresence=${this.touchPresence}, alwaysOn=${this.alwaysOn}, ignoreActive=${this.ignoreActive}, presence=${this.presence}, locked=${this.locked}`);

    if (this.locked) {
      this.logAt("debug", "PRESENCE", "locked — state change suppressed");
      this.sendPresenceUpdate();
      return;
    }

    // alwaysOn (startup grace OR cronAlwaysOnWindow): display ON, no dim, counter untouched.
    // Counter must keep its pre-alwaysOn value so it can resume cleanly when alwaysOn ends.
    if (this.alwaysOn) {
      this.presence = true;
      this.dimmed = false;
      // Startup grace ONLY (never cronAlwaysOnWindows): credit sensor presence seen during the
      // grace window to the countdown, so the screen does not blank the moment the grace ends.
      // Short-hold sensors (e.g. Panasonic PaPIR, ~2s output hold) are LOW again a few seconds
      // after motion, so evaluating the sensor level only at the grace boundary would discard
      // presence that actually occurred inside the window (refs #11).
      // Restricted to the startup grace because the counter is frozen while alwaysOn is active:
      // in a long cronAlwaysOnWindow this would credit motion from many minutes ago.
      // With no sensor presence the counter stays untouched, so an empty room still turns the
      // screen off cleanly at grace end (preserves the #6 phantom-green-bar fix).
      if (this.startupGraceExpiry && this.getSensorPresence()) {
        this.counter = this.config.counterTimeout;
      }
      this.updateScreen(true, "alwaysOn");
      this.startCounter();
      this.sendPresenceUpdate();
      return;
    }

    // RKORELL: Sensor-Presence je nach Mode, plus touchPresence (unabhängig vom Mode)
    let newPresence = this.ignoreActive ? false : this.getSensorPresence();

    if (newPresence) {
      this.presence = true;
      this.counter = this.config.counterTimeout;
      this.dimmed = false;  // Reset dimmed immediately when presence detected
      this.updateScreen(true, this.presenceSources());
      this.startCounter();
    } else {
      this.presence = false;
      // Only (re)start the counter loop if something remains to count down.
      // After expiry timer is null and counter is 0 — avoid spamming "Counter expired"
      // each time updatePresence is invoked by sensor keepalives (e.g. periodic MQTT).
      if (this.timer || this.counter > 0) {
        this.startCounter();
      }
    }
    this.sendPresenceUpdate();
  },

  startCronMonitor: function () {
    if (this.cronInterval) clearInterval(this.cronInterval);
    this.cronInterval = setInterval(() => {
      this.checkRuntime();
      let now = new Date();
      let alwaysOnInfo = this.getActiveAlwaysOnWindow(now);
      let alwaysOn = !!alwaysOnInfo;
      let ignoreActive = !alwaysOn && this.isNowInWindow(this.config.cronIgnoreWindows);

      let alwaysOnChanged = (alwaysOn !== this.prevAlwaysOn);
      let ignoreChanged = (ignoreActive !== this.prevIgnoreActive);

      this.alwaysOn = alwaysOn;
      this.ignoreActive = ignoreActive;
      this.alwaysOnWindow = alwaysOn ? alwaysOnInfo : null;
      this.prevAlwaysOn = alwaysOn;
      this.prevIgnoreActive = ignoreActive;

      if (alwaysOnChanged || ignoreChanged) {
        this.logAt("info", "CRON", "Transition: alwaysOn=" + alwaysOn + ", ignoreActive=" + ignoreActive);
        this.updatePresence();
      } else if (alwaysOn) {
        this.sendPresenceUpdate();
      }
    }, 1000);
  },

  getActiveAlwaysOnWindow: function (now) {
    if (this.startupGraceExpiry) {
      const leftMs = this.startupGraceExpiry - now.getTime();
      if (leftMs > 0) {
        return {
          from: "startup",
          to: "startup",
          total: this.config.startupGracePeriod,
          left: Math.ceil(leftMs / 1000)
        };
      }
      this.startupGraceExpiry = null;
      this.logAt("info", "CRON", "startupGracePeriod expired, normal logic active");
    }
    if (!this.config.cronAlwaysOnWindows || !Array.isArray(this.config.cronAlwaysOnWindows)) return null;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const nowDay = now.getDay();
    for (let window of this.config.cronAlwaysOnWindows) {
      if (window.days && !window.days.includes(nowDay)) continue;
      const [fromH, fromM] = window.from.split(":").map(Number);
      const [toH, toM] = window.to.split(":").map(Number);
      let fromMinutes = fromH * 60 + fromM;
      let toMinutes = toH * 60 + toM;
      let windowStart = new Date(now);
      windowStart.setHours(fromH, fromM, 0, 0);
      let windowEnd = new Date(now);
      windowEnd.setHours(toH, toM, 0, 0);
      if (fromMinutes <= toMinutes) {
        if (nowMinutes >= fromMinutes && nowMinutes < toMinutes) {
          return {
            from: windowStart,
            to: windowEnd,
            total: (toMinutes - fromMinutes) * 60,
            left: (toMinutes - nowMinutes) * 60 - now.getSeconds()
          };
        }
      } else {
        if (nowMinutes >= fromMinutes || nowMinutes < toMinutes) {
          if (nowMinutes >= fromMinutes) {
            windowEnd.setDate(windowEnd.getDate() + 1);
            toMinutes += 24 * 60;
          } else {
            windowStart.setDate(windowStart.getDate() - 1);
            fromMinutes -= 24 * 60;
          }
          return {
            from: windowStart,
            to: windowEnd,
            total: (toMinutes - fromMinutes) * 60,
            left: (toMinutes - nowMinutes) * 60 - now.getSeconds()
          };
        }
      }
    }
    return null;
  },

  isNowInWindow: function (windows) {
    if (!windows || !Array.isArray(windows)) return false;
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const nowDay = now.getDay();
    return windows.some(window => {
      if (window.days && !window.days.includes(nowDay)) return false;
      const [fromH, fromM] = window.from.split(":").map(Number);
      const [toH, toM] = window.to.split(":").map(Number);
      const fromMinutes = fromH * 60 + fromM;
      const toMinutes = toH * 60 + toM;
      if (fromMinutes <= toMinutes) {
        return nowMinutes >= fromMinutes && nowMinutes < toMinutes;
      } else {
        return nowMinutes >= fromMinutes || nowMinutes < toMinutes;
      }
    });
  },

  startCounter: function () {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (this.alwaysOn) {
        this.dimmed = false;
        this.updateScreen(true, "alwaysOn");
        this.sendPresenceUpdate();
        return;
      }
      if (this.ignoreActive) {
        this.dimmed = false;
        this.updateScreen(false, "ignore");
        this.sendPresenceUpdate();
        return;
      }
      if (!this.presence) {
        if (this.config.autoDimmer && !this.dimmed && this.counter === this.config.autoDimmerTimeout) {
          this.dimmed = true;
        }
        if (this.counter <= 0) {
          this.updateScreen(false, "counter-expired");
          clearInterval(this.timer);
          this.timer = null;
          this.counter = 0;
          this.dimmed = false;
        } else {
          this.counter--;
        }
        this.sendPresenceUpdate();
      } else {
        this.counter = this.config.counterTimeout;
        if (this.dimmed) this.dimmed = false;
      }
    }, 1000);
  },

  // Requested state (screenTarget) is separate from the confirmed state (screenOn):
  // screenOn only changes after the command succeeded, a failed command is retried.
  updateScreen: function (on, reason) {
    if (on === this.screenTarget) return;
    this.screenTarget = on;
    this.screenReason = reason;
    this.clearScreenRetry();
    this.screenRetryAttempt = 0;
    this.logAt("info", "SCREEN", `${on ? "ON" : "OFF"} requested (reason: ${reason})`);
    if (on === this.screenOn && !this.screenCmdRunning) return;
    this.runScreenCommand();
  },

  runScreenCommand: function () {
    if (this.screenCmdRunning) {
      this.logAt("debug", "SCREEN", "Previous command still running — new target queued");
      return;
    }
    const on = this.screenTarget;
    const cmd = on ? this.config.onCommand : this.config.offCommand;
    if (!cmd) {
      this.setScreenConfirmed(on);
      return;
    }
    this.screenCmdRunning = true;
    const started = Date.now();
    const slowTimer = setTimeout(() => {
      this.logAt("warn", "SCREEN", `Command "${cmd}" still running after ${SCREEN_CMD_SLOW_MS / 1000}s`);
    }, SCREEN_CMD_SLOW_MS);
    exec(cmd, { timeout: SCREEN_CMD_TIMEOUT_MS }, (err, stdout, stderr) => {
      clearTimeout(slowTimer);
      this.screenCmdRunning = false;
      const duration = Date.now() - started;
      const errText = (stderr || "").trim();
      if (err) {
        const why = err.killed
          ? `timed out after ${SCREEN_CMD_TIMEOUT_MS / 1000}s and was killed`
          : `exit ${err.code}${err.signal ? ", signal " + err.signal : ""}`;
        this.screenFailures++;
        if (!this.screenFirstFailureAt) this.screenFirstFailureAt = started;
        const msg = `${on ? "ON" : "OFF"} command "${cmd}" failed: ${why}${errText ? ", stderr: " + errText : ""} — screen state unchanged (${this.screenOn})`;
        if (this.screenFailures === 1) this.logAt("error", "SCREEN", msg);
        else this.logAt("debug", "SCREEN", msg);
        if (this.screenTarget === on) this.scheduleScreenRetry();
      } else {
        if (this.screenFailures > 0) {
          this.logAt("info", "SCREEN", `Command succeeded after ${this.screenFailures} failed attempt(s), ${Math.round((Date.now() - this.screenFirstFailureAt) / 1000)}s after the first failure`);
          this.screenFailures = 0;
          this.screenFirstFailureAt = null;
        }
        this.logAt("info", "SCREEN", `${on ? "ON" : "OFF"} command "${cmd}" done (exit 0, ${duration} ms)${errText ? ", stderr: " + errText : ""}`);
        this.setScreenConfirmed(on);
      }
      // A newer target arrived while the command was running
      if (this.screenTarget !== on && this.screenTarget !== this.screenOn) this.runScreenCommand();
    });
  },

  scheduleScreenRetry: function () {
    this.clearScreenRetry();
    const delay = SCREEN_RETRY_MS[Math.min(this.screenRetryAttempt, SCREEN_RETRY_MS.length - 1)];
    this.screenRetryAttempt++;
    const target = this.screenTarget;
    this.logAt("debug", "SCREEN", `Retry in ${delay / 1000}s (attempt ${this.screenRetryAttempt})`);
    this.screenRetryTimer = setTimeout(() => {
      this.screenRetryTimer = null;
      if (this.screenTarget === target && this.screenOn !== target) this.runScreenCommand();
    }, delay);
  },

  clearScreenRetry: function () {
    if (this.screenRetryTimer) {
      clearTimeout(this.screenRetryTimer);
      this.screenRetryTimer = null;
    }
  },

  setScreenConfirmed: function (on) {
    if (this.screenOn === on) return;
    this.screenOn = on;
    this.publishHaState();
    this.sendPresenceUpdate();
  },

  sendPresenceUpdate: function () {
    if (this.dimmed !== this.lastLoggedDimmed) {
      this.lastLoggedDimmed = this.dimmed;
      // dimmed is also reset when the screen goes off; only a reset with the screen staying on is a lift
      if (this.dimmed) this.logAt("info", "PRESENCE", `Auto-dimmer: dimmed (counter ${this.counter}s)`);
      else if (this.screenTarget !== false) this.logAt("info", "PRESENCE", "Auto-dimmer: lifted");
    }
    let payload = {
      presence: this.presence,
      counter: this.counter,
      dimmed: this.dimmed,
      alwaysOn: this.alwaysOn,
      ignoreActive: this.ignoreActive,
      screenOn: this.screenOn,
      locked: this.locked
    };
    if (this.alwaysOn && this.alwaysOnWindow) {
      payload.alwaysOnTotal = this.alwaysOnWindow.total;
      payload.alwaysOnLeft = Math.max(0, this.alwaysOnWindow.left);
    }
    this.sendSocketNotification("PRESENCE_UPDATE", payload);
    this.publishHaSensors();
  },

  // --- Home Assistant MQTT-Discovery (switch + optional presence binary_sensors) ---

  buildHaTopics: function () {
    const ha = this.config.homeAssistant || {};
    const objectId = ha.objectId || HA_DEFAULT_OBJECT_ID;
    const prefix = ha.discoveryPrefix || HA_DEFAULT_DISCOVERY_PREFIX;
    const base = HA_BASE_NS + "/" + objectId;
    return {
      objectId: objectId,
      command: base + HA_CMD_SUFFIX,
      state: base + HA_STATE_SUFFIX,
      availability: base + HA_AVAIL_SUFFIX,
      presenceState: base + HA_PRESENCE_SUFFIX,
      motionState: base + HA_MOTION_SUFFIX,
      discovery: prefix + "/switch/" + objectId + "/config",
      occupancyDiscovery: prefix + "/binary_sensor/" + objectId + "_occupancy/config",
      motionDiscovery: prefix + "/binary_sensor/" + objectId + "_motion/config"
    };
  },

  // Shared device block — identical identifiers group switch + sensors under one HA device
  haDevice: function () {
    const ha = this.config.homeAssistant || {};
    return {
      identifiers: ["mmm_psc_" + this.haTopics.objectId],
      name: ha.name || "MagicMirror Screen",
      manufacturer: "MMM-PresenceScreenControl",
      model: "MagicMirror"
    };
  },

  buildDiscoveryPayload: function () {
    const t = this.haTopics;
    return {
      name: null,                 // main entity of the device -> entity_id is just <objectId>
      unique_id: t.objectId,
      command_topic: t.command,
      state_topic: t.state,
      availability_topic: t.availability,
      payload_on: HA_PAYLOAD_ON,
      payload_off: HA_PAYLOAD_OFF,
      state_on: HA_PAYLOAD_ON,
      state_off: HA_PAYLOAD_OFF,
      payload_available: HA_AVAIL_ONLINE,
      payload_not_available: HA_AVAIL_OFFLINE,
      device: this.haDevice()
    };
  },

  buildSensorDiscovery: function (kind) {
    const t = this.haTopics;
    const isMotion = (kind === "motion");
    return {
      name: isMotion ? "Motion" : "Presence",
      unique_id: t.objectId + (isMotion ? "_motion" : "_occupancy"),
      state_topic: isMotion ? t.motionState : t.presenceState,
      device_class: isMotion ? "motion" : "occupancy",
      payload_on: HA_PAYLOAD_ON,
      payload_off: HA_PAYLOAD_OFF,
      availability_topic: t.availability,
      payload_available: HA_AVAIL_ONLINE,
      payload_not_available: HA_AVAIL_OFFLINE,
      device: this.haDevice()
    };
  },

  // Publish callback: HA is optional, failures are warnings (throttled)
  haPublished: function (topic) {
    return (err) => {
      if (err) this.logThrottled("ha-publish", "warn", "HA", `Publish to ${topic} failed: ${err.message || err}`);
    };
  },

  startHomeAssistant: function () {
    if (this.haClient) {
      try { this.haClient.end(true); } catch (e) {}
      this.haClient = null;
    }
    const t = this.buildHaTopics();
    this.haTopics = t;

    // R11: never share the presence sensor's topic — would create a state->presence feedback loop
    if (t.command === this.config.mqttTopic || t.state === this.config.mqttTopic) {
      this.logAt("error", "HA", "homeAssistant topics collide with mqttTopic — HA integration disabled");
      this.haTopics = null;
      return;
    }

    // Which presence binary_sensors to expose: "off" | "occupancy" | "motion" | "both"
    const ep = this.config.homeAssistant.exposePresence || "off";
    const wantMotion = (ep === "motion" || ep === "both");
    const pirActive = (this.config.mode === "PIR" || this.config.mode === "PIR_MQTT");
    if (wantMotion && !pirActive) {
      this.logAt("warn", "HA", "exposePresence requested 'motion' but no PIR mode is active — motion sensor skipped");
    }
    this.haExpose = {
      occupancy: (ep === "occupancy" || ep === "both"),
      motion: wantMotion && pirActive
    };

    const options = {
      reconnectPeriod: HA_RECONNECT_MS,
      queueQoSZero: false,
      will: { topic: t.availability, payload: HA_AVAIL_OFFLINE, retain: true, qos: HA_QOS }
    };
    if (this.config.mqttUser) { options.username = this.config.mqttUser; }
    if (this.config.mqttPassword) { options.password = this.config.mqttPassword; }

    this.haConnected = false;
    this.haErrorActive = false;
    this.haClient = mqtt.connect(this.config.mqttServer, options);

    // connect handler runs on every (re)connect — republishing discovery/availability/state is self-healing
    this.haClient.on("connect", () => {
      this.haConnected = true;
      this.haErrorActive = false;
      this.logAt("info", "HA", "Connected");
      if (this.config.homeAssistant.discovery) {
        this.haClient.publish(t.discovery, JSON.stringify(this.buildDiscoveryPayload()), { retain: true, qos: HA_QOS }, this.haPublished(t.discovery));
        if (this.haExpose.occupancy) {
          this.haClient.publish(t.occupancyDiscovery, JSON.stringify(this.buildSensorDiscovery("occupancy")), { retain: true, qos: HA_QOS }, this.haPublished(t.occupancyDiscovery));
        }
        if (this.haExpose.motion) {
          this.haClient.publish(t.motionDiscovery, JSON.stringify(this.buildSensorDiscovery("motion")), { retain: true, qos: HA_QOS }, this.haPublished(t.motionDiscovery));
        }
      }
      this.haClient.publish(t.availability, HA_AVAIL_ONLINE, { retain: true, qos: HA_QOS }, this.haPublished(t.availability));
      this.publishHaState();
      this.haLastPresence = null;   // force sensor re-publish on (re)connect
      this.haLastPir = null;
      this.publishHaSensors();
      this.haClient.subscribe(t.command, { qos: HA_QOS }, (err) => {
        if (err) this.logAt("warn", "HA", "Subscribe error: " + err);
        else this.logAt("info", "HA", "Subscribed to " + t.command);
      });
    });

    this.haClient.on("message", (topic, message) => {
      const cmd = message.toString().trim().toUpperCase();
      if (cmd === HA_PAYLOAD_ON) {
        this.haPresence = true;
        this.updatePresence();
      } else if (cmd === HA_PAYLOAD_OFF) {
        this.haPresence = false;
        this.updatePresence();
      } else {
        this.logAt("warn", "HA", "Ignoring unknown command payload: " + cmd);
        return;
      }
      // Confirmation publish: snap the switch back to reality if the command was rejected/overridden by cron windows
      this.publishHaState();
    });

    this.haClient.on("error", (err) => {
      if (!this.haErrorActive) {
        this.haErrorActive = true;
        this.logAt("warn", "HA", "Connection error: " + (err.message || err));
      } else {
        this.logAt("debug", "HA", "Connection error (repeated): " + (err.message || err));
      }
    });
    this.haClient.on("close", () => {
      if (this.haConnected) {
        this.haConnected = false;
        this.logAt("info", "HA", "Connection closed");
      } else {
        this.logAt("debug", "HA", "Connection closed");
      }
    });
    this.haClient.on("offline", () => { this.logAt("debug", "HA", "Offline"); });
    this.haClient.on("reconnect", () => { this.logAt("debug", "HA", "Reconnecting"); });
  },

  publishHaState: function () {
    if (!this.haClient || !this.haTopics || typeof this.screenOn !== "boolean") return;
    const payload = this.screenOn ? HA_PAYLOAD_ON : HA_PAYLOAD_OFF;
    this.haClient.publish(this.haTopics.state, payload, { retain: true, qos: HA_STATE_QOS }, this.haPublished(this.haTopics.state));
  },

  // Publish the presence binary_sensors on transitions only (change-guarded)
  publishHaSensors: function () {
    if (!this.haClient || !this.haTopics || !this.haExpose) return;
    if (this.haExpose.occupancy && this.presence !== this.haLastPresence) {
      this.haLastPresence = this.presence;
      this.haClient.publish(this.haTopics.presenceState, this.presence ? HA_PAYLOAD_ON : HA_PAYLOAD_OFF, { retain: true, qos: HA_STATE_QOS }, this.haPublished(this.haTopics.presenceState));
    }
    if (this.haExpose.motion && this.pirPresence !== this.haLastPir) {
      this.haLastPir = this.pirPresence;
      this.haClient.publish(this.haTopics.motionState, this.pirPresence ? HA_PAYLOAD_ON : HA_PAYLOAD_OFF, { retain: true, qos: HA_STATE_QOS }, this.haPublished(this.haTopics.motionState));
    }
  },

  stopHomeAssistant: function () {
    if (!this.haClient) return;
    const client = this.haClient;
    const avail = this.haTopics ? this.haTopics.availability : null;
    this.haClient = null;
    try {
      if (avail) {
        // publish offline first, then end inside the callback so the message is flushed
        client.publish(avail, HA_AVAIL_OFFLINE, { retain: true, qos: HA_QOS }, () => {
          try { client.end(false, {}, () => {}); } catch (e) {}
        });
      } else {
        client.end(true);
      }
    } catch (e) {}
  }
});
