/**
 * MMM-PresenceScreenControl.js
 * MagicMirror² module for presence detection and screen control using PIR and/or MQTT sensors.
 * Shows a presence bar, handles timers, auto-dimming, ignore/always-on windows, and touch override.
 *
 * Author: Dr. Ralf Korell, 2025
 * Based on MMM-Pir (bugsounet/Coernel82) and MMM-MQTTScreenOnOff (olexs)
 * License: MIT
 */

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
    mqttPayloadOccupancyField: "presence",// Field in MQTT payload indicating presence
    onCommand: "vcgencmd display_power 1",// Command to turn the display ON
    offCommand: "vcgencmd display_power 0",// Command to turn the display OFF
    counterTimeout: 120,                  // Seconds to keep the display on after last presence
    autoDimmer: true,                     // Enable/disable auto-dimming instead of instant off
    autoDimmerTimeout: 60,                // Seconds before auto-dimming triggers
    cronIgnoreWindows: [],                // Time windows to ignore all presence
    cronAlwaysOnWindows: [],              // Time windows to keep display always on
    touchMode: 2,                         // Touch mode (0=off, 1=simple, 2=toggle, 3=advanced)
    style: 2,                             // Display style: 2 = bar, 0 = no graphic
    colorFrom: "red",                     // Bar color at timer end (empty)
    colorTo: "lime",                      // Bar color at timer start (full)
    colorCronActivation: "cornflowerblue",// Bar color during always-on window
    showPresenceStatus: true,             // Show "Presence: YES/NO" above the bar
    debug: "simple",                      // Debug level: "off", "simple", "complex"
    resetCountdownWidth: false            // If true, bar jumps to 100% at always-on countdown start
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
    this.sendSocketNotification("CONFIG", this.config);
    this.log("Module started with config: " + JSON.stringify(this.config), "simple");
    this.updateDom();
  },

  /**
   * Debug logging function, controlled by the debug config option.
   */
  log: function (msg, level="simple") {
    if (this.config.debug === "off") return;
    if (this.config.debug === level || this.config.debug === "complex") {
      console.log("PresenceControl: " + msg);
    }
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
          this.fadeRegionsOpacity(0.2, this.config.autoDimmerTimeout * 1000);
        } else {
          this.fadeRegionsOpacity(1.0, 600);
        }
        this.lastDimmedState = this.dimmed;
      }
      this.updateDom();
      this.log("Received PRESENCE_UPDATE: " + JSON.stringify(payload), "complex");
    }
    if (notification === "DEBUG_LOG") {
      this.log(payload, "complex");
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
   * Main DOM rendering: Shows presence status, timer bar, timer text, and overlay.
   * Handles always-on and ignore logic, visual timer bar, and touch overlay.
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

    // Overlay for "off" state (disabled mirror)
    if (!this.presence) {
      if (!document.getElementById("psc-global-overlay")) {
        var overlay = document.createElement("div");
        overlay.className = "psc-overlay";
        overlay.id = "psc-global-overlay";
        overlay.onclick = (e) => {
          this.sendSocketNotification("TOUCH_EVENT", { type: "click" });
        };
        document.body.appendChild(overlay);
      }
    } else {
      var existing = document.getElementById("psc-global-overlay");
      if (existing) existing.parentNode.removeChild(existing);
    }

    return wrapper;
  },

  /**
   * Handles click and touch events for manual override (touchMode).
   * Sends events to node_helper for processing.
   */
  notificationReceived: function(notification, payload, sender) {
    if (notification === "DOM_OBJECTS_CREATED") {
      var wrapper = document.querySelector(".psc-wrapper");
      if (wrapper && this.config.touchMode > 0) {
        wrapper.onclick = (e) => {
          this.sendSocketNotification("TOUCH_EVENT", { type: "click" });
        };
        wrapper.ondblclick = (e) => {
          this.sendSocketNotification("TOUCH_EVENT", { type: "dblclick" });
        };
        let pressTimer = null;
        wrapper.onmousedown = (e) => {
          pressTimer = window.setTimeout(() => {
            this.sendSocketNotification("TOUCH_EVENT", { type: "longclick" });
          }, 1000);
        };
        wrapper.onmouseup = (e) => {
          clearTimeout(pressTimer);
        };
        wrapper.onmouseleave = (e) => {
          clearTimeout(pressTimer);
        };
      }
    }
  }
});
