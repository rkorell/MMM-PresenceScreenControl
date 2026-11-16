/**
 * MMM-PresenceScreenControl.js
 * MagicMirror² module for presence detection and screen control using PIR and/or MQTT sensors.
 * Shows a presence bar, handles timers, auto-dimming, ignore/always-on windows, and touch override.
 *
 * Author: Dr. Ralf Korell, 2025
 * Based on MMM-Pir (bugsounet/Coernel82) and MMM-MQTTScreenOnOff (olexs)
 * License: MIT
 *
 * Modified: 2026-05-05 - Add ecoMode (hide modules while screen is off, opt-in)
 * Modified: 2026-05-05 - Add notification API: emit MMM_PSC-USER_PRESENCE / MMM_PSC-SCREEN_POWERSTATUS, accept MMM_PSC-WAKEUP/LOCK/UNLOCK/END
 * Modified: 2026-06-06 - Add autoDimmerOpacity config option (closes issue #7)
 * Modified: 2026-08-18 - Add optional homeAssistant config block (native HA MQTT-Discovery switch, handled in node_helper)
 * Modified: 2026-08-20 - homeAssistant: add exposePresence option (PIR/presence as HA binary_sensor, handled in node_helper)
 * Modified: 2026-11-16 12:25 - debug is a log threshold ("off" | "error" | "warn" | "info" | "debug"; simple/complex translated); redact credentials in logged config; pass the sender of WAKEUP/END/LOCK/UNLOCK to the node_helper (refs #12)
 */

const ECO_LOCK = "MMM-PSC_ECO_LOCK";
// Same threshold as node_helper.js: a level shows itself and every more severe level
const PSC_LOG_LEVELS = { off: 0, error: 1, warn: 2, info: 3, debug: 4 };
const PSC_LEGACY_DEBUG_LEVELS = { simple: "info", complex: "debug" };

Module.register("MMM-PresenceScreenControl", {
  /**
   * Default configuration values for the module.
   * Adjust these in your config.js as needed.
   */
  defaults: {
    mode: "PIR_MQTT",                     // "PIR", "MQTT", or "PIR_MQTT": which sensor(s) to use
    pirGPIO: 4,                           // GPIO pin (BCM numbering) for PIR sensor
    mqttServer: "mqtt://localhost:1883",  // MQTT broker URL
    mqttTopic: "sensor/presence",         // MQTT topic for presence messages
    mqttPayloadOccupancyField: "presence",// Field in MQTT JSON payload indicating presence (ignored if mqttPayloadOn is set)
    mqttPayloadOn: "",                     // If set, switches to bare-string mode: raw MQTT message must equal this string for presence=true
    mqttUser: "",                          // MQTT broker username (optional)
    mqttPassword: "",                      // MQTT broker password (optional)
    onCommand: "vcgencmd display_power 1",// Command to turn the display ON
    offCommand: "vcgencmd display_power 0",// Command to turn the display OFF
    counterTimeout: 120,                  // Seconds to keep the display on after last presence
    startupGracePeriod: 0,               // Seconds to keep screen on after startup (0 = off after ~1s if nobody present)
    autoDimmer: true,                     // Enable/disable auto-dimming instead of instant off
    autoDimmerTimeout: 60,                // Seconds before auto-dimming triggers
    autoDimmerOpacity: 0.2,               // Target opacity during auto-dim (0.0 = invisible, 1.0 = full)
    cronIgnoreWindows: [],                // Time windows to ignore all presence
    cronAlwaysOnWindows: [],              // Time windows to keep display always on
    style: 2,                             // Display style: 2 = bar, 0 = no graphic
    colorFrom: "red",                     // Bar color at timer end (empty)
    colorTo: "lime",                      // Bar color at timer start (full)
    colorCronActivation: "cornflowerblue",// Bar color during always-on window
    showPresenceStatus: true,             // Show "Presence: YES/NO" above the bar
    debug: "off",                          // Log threshold: "off", "error", "warn", "info", "debug" (each includes the more severe ones)
    logFileName: "",                      // Log destination: "" = console (pm2 logs), "file.log" = file in module dir
    resetCountdownWidth: false,           // If true, bar jumps to 100% at always-on countdown start
    treatExternalWakeupAsPresence: false, // If true, listen on a Unix socket and treat external screen-on signals as presence
    ecoMode: false,                       // If true, hide all other modules while the screen is off (DOM-level; reduces render load)
    ecoModeIgnore: [],                    // Module names to keep visible in ecoMode (e.g. ["MMM-FRITZ-Box-Callmonitor-py3"])
    homeAssistant: {                      // Optional Home Assistant MQTT-Discovery switch (backend-only; reuses the mqtt* settings above)
      enabled: false,                     // Master switch for the whole HA integration
      discovery: true,                    // Publish HA discovery config so the switch entity is auto-created
      discoveryPrefix: "homeassistant",   // HA discovery prefix (match HA's mqtt discovery_prefix)
      objectId: "magicmirror_screen",     // Technical id -> topic paths + HA unique_id; make unique per mirror if several share a broker
      name: "MagicMirror Screen",         // Friendly name shown in Home Assistant (device name)
      exposePresence: "off"               // Also expose presence as HA binary_sensor: "off" | "occupancy" | "motion" | "both" (motion needs a PIR mode)
    }
  },

  fadeTimers: [],
  lastDimmedState: null,
  hasAlwaysOnJumped: false, // Used for resetCountdownWidth logic

  /**
   * Loads the module's CSS file.
   */
  getStyles: function () {
    return ["MMM-PresenceScreenControl.css"];
  },

  /**
   * Initializes module state and sends configuration to the node helper.
   */
  start: function () {
    this.presence = false;
    this.counter = 0;
    this.dimmed = false;
    this.alwaysOn = false;
    this.ignoreActive = false;
    this.alwaysOnTotal = null;
    this.alwaysOnLeft = null;
    this.hasAlwaysOnJumped = false;
    this.lastScreenOn = null;
    this.lastPresenceState = null;
    var level = PSC_LEGACY_DEBUG_LEVELS[this.config.debug] || this.config.debug;
    this.logLevel = PSC_LOG_LEVELS[level] || 0;
    this.sendSocketNotification("CONFIG", this.config);
    this.log("Module started with config: " + this.redactedConfig(), "info");
    this.updateDom();
  },

  /**
   * Logging, controlled by the debug threshold ("off" logs nothing).
   */
  log: function (msg, level) {
    if (!this.logLevel || PSC_LOG_LEVELS[level] > this.logLevel) return;
    console[level]("PresenceControl: " + msg);
  },

  /**
   * Config as JSON with the MQTT password (and a password in the broker URL) masked.
   */
  redactedConfig: function () {
    var copy = Object.assign({}, this.config);
    if (copy.mqttPassword) copy.mqttPassword = "***";
    if (typeof copy.mqttServer === "string") {
      copy.mqttServer = copy.mqttServer.replace(/\/\/([^:@/]+):([^@/]+)@/, "//$1:***@");
    }
    return JSON.stringify(copy);
  },

  /**
   * Fades the opacity of all MagicMirror regions for auto-dimming effect.
   * @param {number} target - Target opacity value
   * @param {number} duration - Fade duration in milliseconds
   */
  fadeRegionsOpacity: function(target, duration) {
    this.fadeTimers.forEach(t => clearTimeout(t));
    this.fadeTimers = [];
    var regions = document.querySelectorAll(".region");
    if (!regions.length) return;
    let current = parseFloat(regions[0].style.opacity) || 1;
    if (current === target) return;
    let steps = Math.max(10, Math.round(duration / 100));
    let diff = (target - current) / steps;
    for (let i = 1; i <= steps; i++) {
      let t = setTimeout(() => {
        let value = current + diff * i;
        regions.forEach((region) => {
          region.style.opacity = value;
        });
      }, i * (duration / steps));
      this.fadeTimers.push(t);
    }
  },

  /**
   * Handles incoming data from the node helper and updates the module state.
   */
  socketNotificationReceived: function (notification, payload) {
    if (notification === "PRESENCE_UPDATE") {
      this.presence = payload.presence;
      this.counter = payload.counter;
      this.dimmed = payload.dimmed;
      this.alwaysOn = payload.alwaysOn;
      this.ignoreActive = payload.ignoreActive;
      this.alwaysOnTotal = payload.alwaysOnTotal;
      this.alwaysOnLeft = payload.alwaysOnLeft;
      if (this.lastDimmedState !== this.dimmed) {
        if (this.dimmed) {
          this.fadeRegionsOpacity(this.config.autoDimmerOpacity, this.config.autoDimmerTimeout * 1000);
        } else {
          this.fadeRegionsOpacity(1.0, 600);
        }
        this.lastDimmedState = this.dimmed;
      }
      if (typeof payload.screenOn === "boolean") {
        if (this.lastScreenOn === null) {
          this.lastScreenOn = payload.screenOn;
        } else if (this.lastScreenOn !== payload.screenOn) {
          this.lastScreenOn = payload.screenOn;
          this.sendNotification("MMM_PSC-SCREEN_POWERSTATUS", payload.screenOn);
          if (this.config.ecoMode) {
            if (payload.screenOn) {
              this.ecoShowAll();
            } else {
              this.ecoHideAll();
            }
          }
        }
      }
      if (typeof payload.presence === "boolean") {
        if (this.lastPresenceState === null) {
          this.lastPresenceState = payload.presence;
        } else if (this.lastPresenceState !== payload.presence) {
          this.lastPresenceState = payload.presence;
          this.sendNotification("MMM_PSC-USER_PRESENCE", payload.presence);
        }
      }
      this.updateDom();
      this.log("Received PRESENCE_UPDATE: " + JSON.stringify(payload), "debug");
    }
    if (notification === "DEBUG_LOG") {
      this.log(payload, "debug");
    }
  },

  /**
   * Calculates a linearly interpolated color between two CSS color strings.
   * Used for smooth bar color transitions as the timer runs down.
   * @param {string} fromCol - Start color (e.g. green)
   * @param {string} toCol - End color (e.g. red)
   * @param {number} percent - Value from 0 (fromCol) to 1 (toCol)
   * @returns {string} - RGB color string
   */
  getCountdownColor: function (fromCol, toCol, percent) {
    function colorToRgb(c) {
      var ctx = document.createElement("canvas").getContext("2d");
      ctx.fillStyle = c;
      var rgb = ctx.fillStyle;
      if (rgb.startsWith("#")) {
        var bigint = parseInt(rgb.slice(1), 16);
        return [(bigint >> 16) & 255, (bigint >> 8) & 255, bigint & 255];
      } else if (rgb.startsWith("rgb")) {
        return rgb.match(/\d+/g).map(Number);
      }
      return [0,0,0];
    }
    var fromRgb = colorToRgb(fromCol);
    var toRgb = colorToRgb(toCol);
    var r = Math.round(fromRgb[0] + (toRgb[0] - fromRgb[0]) * percent);
    var g = Math.round(fromRgb[1] + (toRgb[1] - fromRgb[1]) * percent);
    var b = Math.round(fromRgb[2] + (toRgb[2] - fromRgb[2]) * percent);
    return "rgb(" + r + "," + g + "," + b + ")";
  },

  /**
   * Main DOM rendering: Shows presence status, timer bar, and timer text.
   * Handles always-on and ignore logic, and visual timer bar.
   */
  getDom: function () {
    var wrapper = document.createElement("div");
    wrapper.className = "psc-wrapper";

    // Show presence status above the bar
    if (this.config.showPresenceStatus) {
      var status = document.createElement("div");
      status.innerHTML = "Presence: " + (this.presence ? "<span class='psc-on'>YES</span>" : "<span class='psc-off'>NO</span>");
      wrapper.appendChild(status);
    }

    // Show ignore window hint if active
    if (this.ignoreActive) {
      var ignoreDiv = document.createElement("div");
      ignoreDiv.innerHTML = "<span style='color:gray;'>[Presence Ignored]</span>";
      wrapper.appendChild(ignoreDiv);
    }

    // Bar visualization (style 2 = bar) or nothing (style 0)
    if (this.config.style === 2) {
      // Always-on window logic: bar is blue, then fades to red in last seconds
      if (this.alwaysOn && typeof this.alwaysOnTotal === "number" && typeof this.alwaysOnLeft === "number") {
        let progDiv = document.createElement("div");
        progDiv.className = "psc-linebar";

        if (this.alwaysOnLeft > this.config.counterTimeout) {
          // Bar shrinks in blue during always-on window
          let percent = this.alwaysOnLeft / this.alwaysOnTotal;
          let barWidth = Math.max(1, percent * 100);
          let barColor = this.config.colorCronActivation;
          progDiv.innerHTML = "<div class='psc-bar' style='width:" + barWidth + "%;background:" + barColor + ";'></div>";
          this.hasAlwaysOnJumped = false;
        } else {
          // Final phase: bar fades from blue to red, optionally jumps to 100% width
          let barColor = this.getCountdownColor(this.config.colorCronActivation, this.config.colorFrom, 1 - (this.alwaysOnLeft / this.config.counterTimeout));
          let barWidth;
          if (this.config.resetCountdownWidth && !this.hasAlwaysOnJumped) {
            barWidth = 100;
            this.hasAlwaysOnJumped = true;
          } else if (!this.config.resetCountdownWidth) {
            // No jump: continue smoothly from current width, relative to always-on window
            barWidth = (this.alwaysOnLeft / this.alwaysOnTotal) * 100;
          } else {
            // After jump: normal countdown to zero in end phase
            let phase = Math.max(0, Math.min(1, this.alwaysOnLeft / this.config.counterTimeout));
            barWidth = phase * 100;
          }
          progDiv.innerHTML = "<div class='psc-bar' style='width:" + barWidth + "%;background:" + barColor + ";'></div>";
        }
        wrapper.appendChild(progDiv);

        // Timer text for always-on window
        var total = this.alwaysOnLeft;
        var hours = Math.floor(total / 3600);
        var min = Math.floor((total % 3600) / 60);
        var sec = total % 60;
        var timeDiv = document.createElement("div");
        timeDiv.className = "psc-timer";
        let color;
        if (this.alwaysOnLeft > this.config.counterTimeout) {
          color = this.config.colorCronActivation;
        } else {
          color = this.getCountdownColor(this.config.colorCronActivation, this.config.colorFrom, 1 - Math.max(0, this.alwaysOnLeft / this.config.counterTimeout));
        }
        timeDiv.style.color = color;
        timeDiv.style.textAlign = "center";
        var timeString = (hours > 0 ? ((hours < 10 ? "0" : "") + hours + ":") : "") +
                         (min < 10 ? "0" : "") + min + ":" +
                         (sec < 10 ? "0" : "") + sec;
        timeDiv.innerHTML = timeString;
        wrapper.appendChild(timeDiv);

      } else {
        // Normal presence timer bar (not in always-on window)
        var progDiv = document.createElement("div");
        progDiv.className = "psc-linebar";
        var phase = Math.max(0, this.counter / this.config.counterTimeout);
        var barColor = this.getCountdownColor(this.config.colorTo, this.config.colorFrom, 1 - phase);
        var barWidth = (phase * 100) + "%";
        progDiv.innerHTML = "<div class='psc-bar' style='width:" + barWidth + ";background:" + barColor + ";'></div>";
        wrapper.appendChild(progDiv);

        // Timer text for normal countdown
        var total = this.counter;
        var hours = Math.floor(total / 3600);
        var min = Math.floor((total % 3600) / 60);
        var sec = total % 60;
        var timeDiv = document.createElement("div");
        timeDiv.className = "psc-timer";
        timeDiv.style.color = barColor;
        timeDiv.style.textAlign = "center";
        var timeString = (hours > 0 ? ((hours < 10 ? "0" : "") + hours + ":") : "") +
                         (min < 10 ? "0" : "") + min + ":" +
                         (sec < 10 ? "0" : "") + sec;
        timeDiv.innerHTML = timeString;
        wrapper.appendChild(timeDiv);
      }
    }

    return wrapper;
  },

  /**
   * Hide all other modules while the screen is off.
   * Uses a private lockString so user-initiated hides (e.g. via MMM-Remote-Control)
   * are respected and not overridden.
   */
  ecoHideAll: function () {
    var self = this;
    MM.getModules().enumerate(function (m) {
      if (m.name === self.name) return;
      if (self.config.ecoModeIgnore.indexOf(m.name) !== -1) return;
      m.hide(0, function () {}, { lockString: ECO_LOCK });
    });
    this.log("ecoMode: hide all modules", "info");
  },

  /**
   * Show all other modules when the screen turns on.
   * Releases only our own lockString — modules locked by other components
   * remain hidden (LOCK_STRING_ACTIVE on onError, logged at complex level).
   */
  ecoShowAll: function () {
    var self = this;
    MM.getModules().enumerate(function (m) {
      if (m.name === self.name) return;
      m.show(0, function () {}, {
        lockString: ECO_LOCK,
        onError: function (err) {
          self.log("ecoMode: show blocked for " + m.name + " — " + err, "debug");
        }
      });
    });
    this.log("ecoMode: show all modules", "info");
  },

  /**
   * Window-level click handler for touch/click wakeup.
   * Any click wakes up the screen and resets the presence timer.
   */
  notificationReceived: function(notification, payload, sender) {
    if (notification === "DOM_OBJECTS_CREATED") {
      var self = this;
      window.addEventListener("click", function(e) {
        self.sendSocketNotification("TOUCH_EVENT", { type: "click" });
      }, false);
    } else if (notification === "MMM_PSC-WAKEUP") {
      this.sendSocketNotification("EXT_WAKEUP", { sender: sender ? sender.name : "system" });
    } else if (notification === "MMM_PSC-END") {
      this.sendSocketNotification("EXT_END", { sender: sender ? sender.name : "system" });
    } else if (notification === "MMM_PSC-LOCK") {
      this.sendSocketNotification("EXT_LOCK", { sender: sender ? sender.name : "system" });
    } else if (notification === "MMM_PSC-UNLOCK") {
      this.sendSocketNotification("EXT_UNLOCK", { sender: sender ? sender.name : "system" });
    }
  }
});
