/**
 * node_helper.js for MMM-PresenceScreenControl
 * Backend logic for presence and screen control using PIR and/or MQTT sensors.
 * Manages timers, cron-based ignore/always-on windows, auto-dimming, and executes user-supplied commands.
 * 
 * Author: Dr. Ralf Korell, 2025
 * Integrates logic and ideas from MMM-Pir (bugsounet/Coernel82) and MMM-MQTTScreenOnOff (olexs)
 * License: MIT
 */


const NodeHelper = require("node_helper");
const { exec } = require("child_process");
const mqtt = require("mqtt");
const fs = require("fs");
const { spawn } = require("child_process");
const path = require("path");
const PIR = require("./pirLib");

let pirProcess = null;

module.exports = NodeHelper.create({
  start: function () {
    this.presence = false;
    this.counter = 0;
    this.timer = null;
    this.dimmed = false;
    this.alwaysOn = false;
    this.ignoreActive = false;
    this.touchActive = false;
    this.config = {};
    this.mqttClient = null;
    this.logFile = path.join(__dirname, "MMM-PresenceScreenControl_local.log");
    this.debug = "off";
    this.touchScreenOn = false;
    this.touchScreenOff = false;
    this.pirInstance = null;
    this.pirPresence = false;
    this.mqttPresence = false;
    this.touchPresence = false;
    this.touchTimer = null;
    this.alwaysOnWindow = null;
  },

  log: function (msg, level = "simple") {
    const timestamp = new Date().toISOString();
    const logMsg = `[${timestamp}] PresenceControl: ${msg}\n`;
    if (this.config.debug && (this.config.debug === level || this.config.debug === "complex")) {
      fs.appendFile(this.logFile, logMsg, err => {
        if (err) console.error("PresenceControl (log write error):", err);
      });
    }
    if (level === "complex" && this.config.debug === "complex") {
      this.sendSocketNotification("DEBUG_LOG", msg);
    }
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "CONFIG") {
      this.config = payload;
      this.debug = payload.debug || "off";
      this.log("Received config: " + JSON.stringify(this.config), "simple");
      if (this.config.mode === "PIR" || this.config.mode === "PIR_MQTT") {
        this.startPirSensor();
      }
      if (this.config.mode === "MQTT" || this.config.mode === "PIR_MQTT") {
        this.startMqtt();
      }
      this.startCronMonitor();
    } else if (notification === "TOUCH_EVENT") {
      this.handleTouch(payload);
    }
  },

  handleTouch: function (payload) {
    let event = payload.type;
    this.log(`Touch event received: ${event}`, "simple");

    if (event === "click") {
      this.triggerPresence();
    } else if (event === "dblclick") {
      this.shutdownScreen();
    }
  },

  triggerPresence: function () {
    this.log("Touch: Triggering presence event (screen on/timer reset).", "simple");
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

  shutdownScreen: function () {
    this.log("Touch: Shutting down screen via touch event.", "simple");
    this.presence = false;
    this.counter = 0;
    this.updateScreen(false);

    // Disconnect VNC session after screen off (prevents "mini window" problem)
    if (this.config.vncDisconnectCommand) {
      exec(this.config.vncDisconnectCommand, (err, stdout, stderr) => {
        if (err) {
          this.log("VNC disconnect error: " + err, "simple");
        } else {
          this.log("VNC session disconnected", "simple");
        }
      });
    }

    this.sendPresenceUpdate();
  },

  toggleScreen: function () {
    this.log("Touch: Toggling screen via touch event.", "simple");
    if (this.presence) {
      this.shutdownScreen();
    } else {
      this.triggerPresence();
    }
  },

  // PRÄMISSENTREU: PIR-Integration mit eigenem State
  startPirSensor: function () {
    if (this.pirInstance) this.pirInstance.stop();
    this.pirInstance = new PIR(
      { 
        gpio: this.config.pirGPIO || 4,
        mode: 0,
        debug: (this.config.debug === "complex")
      }, 
      (event, data) => {
        if (event === "PIR_DETECTED") {
          console.log("[node_helper] PIR_DETECTED received");
          this.pirPresence = true;
          // RKORELL: Touch-Mechanismus nullen wenn echte Präsenz erkannt
          this.touchPresence = false;
          if (this.touchTimer) {
            clearTimeout(this.touchTimer);
            this.touchTimer = null;
          }
        } else if (event === "PIR_LEFT") {
          console.log("[node_helper] PIR_LEFT received, setting pirPresence=false");
          this.pirPresence = false;
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
    this.mqttClient = mqtt.connect(this.config.mqttServer);
    this.mqttClient.on("connect", () => {
      this.mqttClient.subscribe(this.config.mqttTopic, (err) => {
        if (err) this.log("MQTT subscribe error: " + err, "simple");
        else this.log("Subscribed to MQTT topic: " + this.config.mqttTopic, "simple");
      });
    });
    this.mqttClient.on("message", (topic, message) => {
      try {
        let payload = JSON.parse(message.toString());
        let field = this.config.mqttPayloadOccupancyField || "presence";
        let occ = payload[field];
        let presence = (typeof occ === "boolean") ? occ : (occ === "1" || occ === 1 || occ === "true");
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
      } catch (e) {
        this.log("MQTT payload parse error: " + e, "simple");
      }
    });
    this.mqttClient.on("error", (err) => {
      this.log("MQTT connection error: " + err, "simple");
    });
  },

  // PRÄMISSENTREU: State-Decision je nach Mode
  updatePresence: function () {
    let newPresence = false;
    if (this.alwaysOn) {
      newPresence = true;
    } else if (this.ignoreActive) {
      newPresence = false;
    } else {
      // RKORELL: Sensor-Presence je nach Mode, plus touchPresence (unabhängig vom Mode)
      let sensorPresence = false;
      if (this.config.mode === "PIR_MQTT") {
        sensorPresence = (this.pirPresence || this.mqttPresence);
      } else if (this.config.mode === "PIR") {
        sensorPresence = this.pirPresence;
      } else if (this.config.mode === "MQTT") {
        sensorPresence = this.mqttPresence;
      }
      newPresence = sensorPresence || this.touchPresence;
    }
    console.log(`[updatePresence] pirPresence=${this.pirPresence}, touchPresence=${this.touchPresence}, presence=${this.presence}, newPresence=${newPresence}`);
    if (newPresence) {
      this.presence = true;
      this.counter = this.config.counterTimeout;
      this.dimmed = false;  // Reset dimmed immediately when presence detected
      this.updateScreen(true);
      this.startCounter();
    } else {
      this.presence = false;
      this.startCounter();
    }
    this.sendPresenceUpdate();
  },

  startCronMonitor: function () {
    if (this.cronInterval) clearInterval(this.cronInterval);
    this.cronInterval = setInterval(() => {
      let now = new Date();
      let alwaysOnInfo = this.getActiveAlwaysOnWindow(now);
      let alwaysOn = !!alwaysOnInfo;
      let ignoreActive = !alwaysOn && this.isNowInWindow(this.config.cronIgnoreWindows);

      this.alwaysOn = alwaysOn;
      this.ignoreActive = ignoreActive;
      if (alwaysOn) {
        this.alwaysOnWindow = alwaysOnInfo;
      } else {
        this.alwaysOnWindow = null;
      }
      this.log("Cron check: alwaysOn=" + alwaysOn + ", ignoreActive=" + ignoreActive, "complex");
      this.sendPresenceUpdate();
    }, 1000);
  },

  getActiveAlwaysOnWindow: function (now) {
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
        this.updateScreen(true);
        this.sendPresenceUpdate();
        return;
      }
      if (this.ignoreActive) {
        this.dimmed = false;
        this.updateScreen(false);
        this.sendPresenceUpdate();
        return;
      }
      if (!this.presence) {
        if (this.config.autoDimmer && !this.dimmed && this.counter === this.config.autoDimmerTimeout) {
          this.dimmed = true;
        }
        if (this.counter <= 0) {
          console.log(`[startCounter] Counter expired: presence=${this.presence}, pirPresence=${this.pirPresence}, calling updateScreen(false)`);
          this.updateScreen(false);
          clearInterval(this.timer);
          this.counter = 0;
          this.dimmed = false;
          this.log("Counter expired, set presence to FALSE and stopped timer.", "complex");
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

  updateScreen: function (on) {
    let cmd = on ? this.config.onCommand : this.config.offCommand;
    console.log(`[updateScreen] on=${on}, cmd="${cmd}"`);
    if (cmd) {
      exec(cmd, (err, stdout, stderr) => {
        if (err) {
          console.log(`[updateScreen] ERROR: ${err}`);
          this.log("Screen command error: " + err, "simple");
        }
        else {
          console.log(`[updateScreen] SUCCESS: executed "${cmd}"`);
          this.log("Executed screen command: " + cmd, "simple");
        }
      });
    }
    this.sendPresenceUpdate();
  },

  sendPresenceUpdate: function () {
    let payload = {
      presence: this.presence,
      counter: this.counter,
      dimmed: this.dimmed,
      alwaysOn: this.alwaysOn,
      ignoreActive: this.ignoreActive
    };
    if (this.alwaysOn && this.alwaysOnWindow) {
      payload.alwaysOnTotal = this.alwaysOnWindow.total;
      payload.alwaysOnLeft = Math.max(0, this.alwaysOnWindow.left);
    }
    this.sendSocketNotification("PRESENCE_UPDATE", payload);
  }
});
