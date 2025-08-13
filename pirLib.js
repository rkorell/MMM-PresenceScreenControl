/**
 * pirLib.js
 * Helper library for PIR sensor access using node-libgpiod.
 *
 * Author: Dr. Ralf Korell, 2025
 * Originally from MMM-Pir (bugsounet/Coernel82), 
 * updated for label-free GPIO chip detection.
 * 
 * CHANGE: Instead of searching for a chip by label, this implementation
 * dynamically scans all /dev/gpiochip* devices. 
 * Rationale: Modern Linux kernels and Pi OS often do not assign stable or meaningful labels to GPIO chips.
 * Old label-based detection can fail or select the wrong chip. 
 * Scanning all gpiochip devices makes detection reliable on current systems.
 * 
 * License: MIT
 */

var log = () => { /* do nothing */ };

class PIR {
  constructor (config, callback) {
    this.config = config;
    this.callback = callback;
    this.default = {
      debug: false,
      gpio: 21,
      mode: 0
    };
    this.config = Object.assign({}, this.default, this.config);
    if (this.config.debug) log = (...args) => { console.log("[MMM-Pir] [LIB] [PIR]", ...args); };
    this.pir = null;
    this.running = false;
    this.pirChip = null;
    this.pirLine = null;
    this.pirChipNumber = -1;
    this.pirInterval = null;
    this.pirReadyToDetect = false;
    this.oldstate = undefined;
  }

  start () {
    if (this.running) return;
    if (this.config.gpio === 0) return console.log("[MMM-Pir] [LIB] [PIR] Disabled.");
    switch (this.config.mode) {
      case 0:
        console.log("[MMM-Pir] [LIB] [PIR] Mode 0 Selected (gpiod library)");
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
    if (this.config.mode === 0 && this.pirLine) {
      clearInterval(this.pirInterval);
      this.pirLine.release();
      this.pirLine = null;
    }
    if (this.config.mode === 1 && this.pir) {
      this.pir.kill();
    }
    this.pir = null;
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
      console.warn(`[MMM-Pir] [LIB] [PIR] [PYTHON] The exit code was: ${code}`);
      console.warn(`[MMM-Pir] [LIB] [PIR] [PYTHON] The exit signal was: ${signal}`);
    });
  }

  gpiodDetect () {
    try {
      const fs = require('fs');
      const { Chip, Line } = require("node-libgpiod");
      // Dynamically search all /dev/gpiochip* devices (label-frei, prämissentreu)
      const chips = fs.readdirSync('/dev').filter(x => x.startsWith('gpiochip'));
      let found = false;
      for (const dev of chips) {
        try {
          let chip = new Chip(`/dev/${dev}`);
          this.pirChip = chip;
          this.pirChipNumber = parseInt(dev.replace('gpiochip',''));
          found = true;
          console.log(`[MMM-Pir] [LIB] [PIR] [GPIOD] Found usable chip: /dev/${dev}`);
          break;
        } catch (e) {
          continue;
        }
      }
      if (!found) {
        console.error("[MMM-Pir] [LIB] [PIR] [GPIOD] No usable GPIO chip found!");
        this.running = false;
        return this.callback("PIR_ERROR", "No Chip Found!");
      }

      this.pirLine = new Line(this.pirChip, this.config.gpio);
      this.pirLine.requestInputMode();
      this.callback("PIR_STARTED");
      console.log("[MMM-Pir] [LIB] [PIR] Started!");
    } catch (err) {
      if (this.pirLine) {
        this.pirLine.release();
        this.pirLine = null;
      }
      console.error(`[MMM-Pir] [LIB] [PIR] [GPIOD] ${err}`);
      this.running = false;
      return this.callback("PIR_ERROR", err.message);
    }

    this.running = true;

    this.pir = () => {
      var line = this.pirLine;
      if (this.running) {
        try {
          var value = line.getValue();
          if (typeof this.oldstate === "undefined") {
            this.oldstate = value;
          }
          if (value !== this.oldstate) {
            log(`Sensor state changed: ${this.oldstate} -> ${value}`);
            this.oldstate = value;
          }
          // Prämissentreu: Jeder Tick meldet den aktuellen Zustand (MQTT-äquivalent)
          if (value === 1) {
            this.callback("PIR_DETECTED");
          } else {
            this.callback("PIR_LEFT");
          }
        } catch (err) {
          console.error(`[MMM-Pir] [LIB] [PIR] [GPIOD] ${err}`);
          this.callback("PIR_ERROR", err);
        }
      }
    };
    this.pirInterval = setInterval(() => this.pir(), 1000);
  }
}

module.exports = PIR;
