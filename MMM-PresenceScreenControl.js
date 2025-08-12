/**
 * MMM-PresenceScreenControl.js
 * MagicMirror² presence, always-on and timer bar frontend
 * (C) Dr. Ralf Korell, August 2025
 *
 * Features:
 * - Shows a colored timer bar for presence/always-on (style=2)
 * - style=0: no graphic at all
 * - Handles "always on" windows and "ignore" windows
 * - Supports PIR, MQTT and touch triggers
 * - resetCountdownWidth: if true, always-on bar jumps to 100% at end of window
 * - Otherwise: bar continues "soft" at current width (no jump)
 */

Module.register("MMM-PresenceScreenControl", {
  defaults: {
    mode: "PIR_MQTT", // "PIR", "MQTT" or "PIR_MQTT"
    pirGPIO: 4, // GPIO pin for PIR sensor (BCM numbering)
    mqttServer: "mqtt://localhost:1883", // MQTT broker URL
    mqttTopic: "sensor/presence", // MQTT topic for presence
    mqttPayloadOccupancyField: "presence", // Field name in MQTT payload
    onCommand: "DISPLAY=:0.0 xrandr --output HDMI-1 --primary --mode 2560x1440 --rate 59.951 --pos 0x0 --rotate left", // Command to turn display on
    offCommand: "DISPLAY=:0.0 xrandr --output HDMI-1 --off", // Command to turn display off
    counterTimeout: 120, // Presence stays active for this many seconds after last event
    autoDimmer: true, // Enable/disable auto-dimming feature
    autoDimmerTimeout: 60, // Time (in seconds) before auto-dim triggers
    cronIgnoreWindows: [], // List of time windows (see docs) to ignore presence
    cronAlwaysOnWindows: [], // List of time windows for always-on
    touchMode: 2, // Touch interaction mode (0=off, 1=simple, 2=toggle, 3=advanced)
    style: 2, // 0 = no graphic, 2 = bar (the only supported style)
    colorFrom: "red", // End color for countdown bar (should be "red")
    colorTo: "lime", // Start color for countdown bar (should be "lime")
    colorCronActivation: "cornflowerblue", // Color for always-on mode
    showPresenceStatus: true, // Show YES/NO status above bar
    debug: "simple", // Debug level: "off", "simple", "complex"
    resetCountdownWidth: false // If true, always-on bar resets to 100% width in final phase
  },

  fadeTimers: [],
  lastDimmedState: null,
  hasAlwaysOnJumped: false, // Internal state for one-time jump

  getStyles: function () {
    return ["MMM-PresenceScreenControl.css"];
  },

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

  log: function (msg, level="simple") {
    if (this.config.debug === "off") return;
    if (this.config.debug === level || this.config.debug === "complex") {
      console.log("PresenceControl: " + msg);
    }
  },

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
   * Calculates the color for the countdown bar as a linear interpolation between two colors.
   * @param {string} fromCol - Start color.
   * @param {string} toCol - End color.
   * @param {number} percent - Interpolation parameter [0,1].
   * @returns {string} The interpolated color in rgb() format.
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
   * Main DOM rendering for the module.
   * Shows status, the presence bar (with always-on logic), timer text and overlay.
   * Only style=2 (bar) or style=0 (no graphic) is supported.
   */
  getDom: function () {
    var wrapper = document.createElement("div");
    wrapper.className = "psc-wrapper";

    // Show presence status if enabled
    if (this.config.showPresenceStatus) {
      var status = document.createElement("div");
      status.innerHTML = "Presence: " + (this.presence ? "<span class='psc-on'>YES</span>" : "<span class='psc-off'>NO</span>");
      wrapper.appendChild(status);
    }

    // Show ignore mode if active
    if (this.ignoreActive) {
      var ignoreDiv = document.createElement("div");
      ignoreDiv.innerHTML = "<span style='color:gray;'>[Presence Ignored]</span>";
      wrapper.appendChild(ignoreDiv);
    }

    // Only show bar if style==2
    if (this.config.style === 2) {
      // Always-On bar logic
      if (this.alwaysOn && typeof this.alwaysOnTotal === "number" && typeof this.alwaysOnLeft === "number") {
        let progDiv = document.createElement("div");
        progDiv.className = "psc-linebar";

        if (this.alwaysOnLeft > this.config.counterTimeout) {
          let percent = this.alwaysOnLeft / this.alwaysOnTotal;
          let barWidth = Math.max(1, percent * 100);
          let barColor = this.config.colorCronActivation;
          progDiv.innerHTML = "<div class='psc-bar' style='width:" + barWidth + "%;background:" + barColor + ";'></div>";
          this.hasAlwaysOnJumped = false; // Reset for next window
        } else {
          // End phase (last counterTimeout seconds)
          let barColor = this.getCountdownColor(this.config.colorCronActivation, this.config.colorFrom, 1 - (this.alwaysOnLeft / this.config.counterTimeout));
          let barWidth;
          if (this.config.resetCountdownWidth && !this.hasAlwaysOnJumped) {
            barWidth = 100;
            this.hasAlwaysOnJumped = true;
          } else if (!this.config.resetCountdownWidth) {
            // Continue soft: barWidth stays relative to always-on window (never jumps)
            barWidth = (this.alwaysOnLeft / this.alwaysOnTotal) * 100;
          } else {
            // After jump: normal countdown to zero in end phase
            let phase = Math.max(0, Math.min(1, this.alwaysOnLeft / this.config.counterTimeout));
            barWidth = phase * 100;
          }
          progDiv.innerHTML = "<div class='psc-bar' style='width:" + barWidth + "%;background:" + barColor + ";'></div>";
        }
        wrapper.appendChild(progDiv);

        // Timer display for always-on
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
        // Normal timer bar
        var progDiv = document.createElement("div");
        progDiv.className = "psc-linebar";
        var phase = Math.max(0, this.counter / this.config.counterTimeout);
        var barColor = this.getCountdownColor(this.config.colorTo, this.config.colorFrom, 1 - phase);
        var barWidth = (phase * 100) + "%";
        progDiv.innerHTML = "<div class='psc-bar' style='width:" + barWidth + ";background:" + barColor + ";'></div>";
        wrapper.appendChild(progDiv);

        // Normal timer display
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
    // style==0: show nothing (no graphic)

    // Overlay for off state
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
