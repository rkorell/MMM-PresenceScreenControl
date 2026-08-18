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
 */


const NodeHelper = require("node_helper");
const { exec } = require("child_process");
const mqtt = require("mqtt");
const net = require("net");
const fs = require("fs");
const path = require("path");
const PIR = require("./pirLib");

const WAKEUP_SOCKET_NAME = "mmm-psc-wakeup.sock";

// --- Home Assistant MQTT integration constants ---
const HA_BASE_NS = "magicmirror";          // topic namespace for command/state/availability (distinct from sensor topic)
const HA_CMD_SUFFIX = "/set";
const HA_STATE_SUFFIX = "/state";
const HA_AVAIL_SUFFIX = "/availability";
const HA_DEFAULT_OBJECT_ID = "magicmirror_screen";
const HA_DEFAULT_DISCOVERY_PREFIX = "homeassistant";
const HA_PAYLOAD_ON = "ON";
const HA_PAYLOAD_OFF = "OFF";
const HA_AVAIL_ONLINE = "online";
const HA_AVAIL_OFFLINE = "offline";
const HA_RECONNECT_MS = 5000;
const HA_QOS = 1;          // discovery, availability, command-subscribe, LWT
const HA_STATE_QOS = 0;    // state publishes

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
    this.screenOn = null;
    this.wakeupServer = null;
    this.wakeupSocketPath = null;
    this.locked = false;
    this.startupGraceExpiry = null;
    this.haClient = null;
    this.haPresence = false;
    this.haTopics = null;
  },

  stop: function () {
    if (this.timer) clearInterval(this.timer);
    if (this.cronInterval) clearInterval(this.cronInterval);
    if (this.touchTimer) clearTimeout(this.touchTimer);
    if (this.pirInstance) {
      this.pirInstance.stop();
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

  log: function (msg, level = "simple") {
    if (!this.config.debug || this.config.debug === "off") return;
    if (this.config.debug === level || this.config.debug === "complex") {
      const timestamp = new Date().toISOString();
      const prefix = `[${timestamp}] PresenceControl: `;
      if (this.config.logFileName) {
        fs.appendFile(path.join(__dirname, this.config.logFileName), prefix + msg + "\n", err => {
          if (err) console.error("PresenceControl (log write error):", err);
        });
      } else {
        console.log(prefix + msg);
      }
    }
    if (level === "complex" && this.config.debug === "complex") {
      this.sendSocketNotification("DEBUG_LOG", msg);
    }
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "CONFIG") {
      this.config = payload;
      if (this.config.autoDimmer && this.config.autoDimmerTimeout >= this.config.counterTimeout) {
        this.config.autoDimmerTimeout = Math.max(0, this.config.counterTimeout - 1);
        console.log(`PresenceControl: autoDimmerTimeout clamped to ${this.config.autoDimmerTimeout} (must be less than counterTimeout ${this.config.counterTimeout})`);
      }
      if (typeof this.config.autoDimmerOpacity !== "number" ||
          this.config.autoDimmerOpacity < 0 || this.config.autoDimmerOpacity > 1) {
        const original = this.config.autoDimmerOpacity;
        const clamped = Math.min(1, Math.max(0, Number(original) || 0.2));
        console.log(`PresenceControl: autoDimmerOpacity ${original} out of range [0,1], clamped to ${clamped}`);
        this.config.autoDimmerOpacity = clamped;
      }
      this.log("Received config: " + JSON.stringify(this.config), "simple");
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
        this.log(`[startupGrace] active (${this.config.startupGracePeriod}s)`, "complex");
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
      if (this.config.treatExternalWakeupAsPresence) {
        this.startWakeupListener();
      }
      this.updatePresence();
    } else if (notification === "TOUCH_EVENT") {
      this.handleTouch(payload);
    } else if (notification === "EXT_WAKEUP") {
      this.log("External notification: WAKEUP", "simple");
      this.triggerPresence();
    } else if (notification === "EXT_END") {
      this.log("External notification: END (force screen off)", "simple");
      this.forceScreenOff();
    } else if (notification === "EXT_LOCK") {
      this.log("External notification: LOCK", "simple");
      this.locked = true;
      this.sendPresenceUpdate();
    } else if (notification === "EXT_UNLOCK") {
      this.log("External notification: UNLOCK", "simple");
      this.locked = false;
      this.updatePresence();
    }
  },

  forceScreenOff: function () {
    this.presence = false;
    this.touchPresence = false;
    this.counter = 0;
    this.dimmed = false;
    this.updateScreen(false);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.sendPresenceUpdate();
  },

  handleTouch: function (payload) {
    this.log("Touch event received: click", "simple");
    this.triggerPresence();
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

  startWakeupListener: function () {
    const runtimeDir = process.env.XDG_RUNTIME_DIR || "/tmp";
    this.wakeupSocketPath = path.join(runtimeDir, WAKEUP_SOCKET_NAME);
    try { fs.unlinkSync(this.wakeupSocketPath); } catch (e) {}
    this.wakeupServer = net.createServer((conn) => {
      conn.on("data", () => {
        this.log("[ExternalWakeup] received ping, triggering presence", "simple");
        this.triggerPresence();
        conn.end();
      });
      conn.on("error", () => {});
    });
    this.wakeupServer.on("error", (err) => {
      console.error("PresenceControl: wakeup socket error: " + err);
      this.log("[ExternalWakeup] socket error: " + err, "simple");
    });
    this.wakeupServer.listen(this.wakeupSocketPath, () => {
      this.log("[ExternalWakeup] listening on " + this.wakeupSocketPath, "simple");
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
    if (this.pirInstance) this.pirInstance.stop();
    this.pirInstance = new PIR(
      {
        gpio: this.config.pirGPIO || 4,
        mode: 0,
        debug: (this.config.debug === "complex")
      },
      (event, data) => {
        if (event === "PIR_DETECTED") {
          this.log("[PIR] PIR_DETECTED received", "simple");
          this.pirPresence = true;
          // RKORELL: Touch-Mechanismus nullen wenn echte Präsenz erkannt
          this.touchPresence = false;
          if (this.touchTimer) {
            clearTimeout(this.touchTimer);
            this.touchTimer = null;
          }
        } else if (event === "PIR_LEFT") {
          this.log("[PIR] PIR_LEFT received, setting pirPresence=false", "simple");
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
    var mqttOptions = {};
    if (this.config.mqttUser) { mqttOptions.username = this.config.mqttUser; }
    if (this.config.mqttPassword) { mqttOptions.password = this.config.mqttPassword; }
    this.mqttClient = mqtt.connect(this.config.mqttServer, mqttOptions);
    this.mqttClient.on("connect", () => {
      this.mqttClient.subscribe(this.config.mqttTopic, (err) => {
        if (err) this.log("MQTT subscribe error: " + err, "simple");
        else this.log("Subscribed to MQTT topic: " + this.config.mqttTopic, "simple");
      });
    });
    this.mqttClient.on("message", (topic, message) => {
      const raw = message.toString();
      const bareMode = !!this.config.mqttPayloadOn;
      let presence;

      if (bareMode) {
        if (this.config.mqttPayloadOccupancyField && this.config.mqttPayloadOccupancyField !== "presence") {
          this.log("[MQTT] mqttPayloadOccupancyField is ignored in bare-string mode", "simple");
        }
        presence = (raw.trim() === this.config.mqttPayloadOn);
      } else {
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch (e) {
          this.log("[MQTT] Field mode JSON parse error: " + e + " — payload: " + raw, "simple");
          return;
        }
        const field = this.config.mqttPayloadOccupancyField || "presence";
        presence = this.coercePresence(payload && payload[field]);
      }

      this.log(`[MQTT] received (${bareMode ? "bare" : "field"} mode): mqttPresence=${presence}`, "complex");
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
    this.mqttClient.on("error", (err) => {
      this.log("MQTT connection error: " + err, "simple");
    });
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

  // PRÄMISSENTREU: State-Decision je nach Mode
  updatePresence: function () {
    this.log(`[updatePresence] pirPresence=${this.pirPresence}, mqttPresence=${this.mqttPresence}, touchPresence=${this.touchPresence}, alwaysOn=${this.alwaysOn}, ignoreActive=${this.ignoreActive}, presence=${this.presence}, locked=${this.locked}`, "complex");

    if (this.locked) {
      this.log("[updatePresence] locked — state change suppressed", "complex");
      this.sendPresenceUpdate();
      return;
    }

    // alwaysOn (startup grace OR cronAlwaysOnWindow): display ON, no dim, counter untouched.
    // Counter must keep its pre-alwaysOn value so it can resume cleanly when alwaysOn ends.
    if (this.alwaysOn) {
      this.presence = true;
      this.dimmed = false;
      this.updateScreen(true);
      this.startCounter();
      this.sendPresenceUpdate();
      return;
    }

    // RKORELL: Sensor-Presence je nach Mode, plus touchPresence (unabhängig vom Mode)
    let newPresence = false;
    if (this.ignoreActive) {
      newPresence = false;
    } else {
      let sensorPresence = false;
      if (this.config.mode === "PIR_MQTT") {
        sensorPresence = (this.pirPresence || this.mqttPresence);
      } else if (this.config.mode === "PIR") {
        sensorPresence = this.pirPresence;
      } else if (this.config.mode === "MQTT") {
        sensorPresence = this.mqttPresence;
      }
      newPresence = sensorPresence || this.touchPresence || this.haPresence;
    }

    if (newPresence) {
      this.presence = true;
      this.counter = this.config.counterTimeout;
      this.dimmed = false;  // Reset dimmed immediately when presence detected
      this.updateScreen(true);
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
        this.log("Cron transition: alwaysOn=" + alwaysOn + ", ignoreActive=" + ignoreActive, "simple");
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
      this.log("[startupGrace] expired, normal logic active", "complex");
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
          this.log(`[startCounter] Counter expired: presence=${this.presence}, pirPresence=${this.pirPresence}, calling updateScreen(false)`, "simple");
          this.updateScreen(false);
          clearInterval(this.timer);
          this.timer = null;
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
    if (on === this.screenOn) return;
    this.screenOn = on;
    this.publishHaState();
    this.sendPresenceUpdate();
    let cmd = on ? this.config.onCommand : this.config.offCommand;
    this.log(`[updateScreen] on=${on}, cmd="${cmd}"`, "simple");
    if (cmd) {
      exec(cmd, (err, stdout, stderr) => {
        if (err) {
          console.error(`[updateScreen] ERROR: ${err}`);
          this.log("Screen command error: " + err, "simple");
        }
        else {
          this.log(`[updateScreen] SUCCESS: executed "${cmd}"`, "simple");
        }
      });
    }
  },

  sendPresenceUpdate: function () {
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
  },

  // --- Home Assistant MQTT-Discovery switch ---

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
      discovery: prefix + "/switch/" + objectId + "/config"
    };
  },

  buildDiscoveryPayload: function () {
    const ha = this.config.homeAssistant || {};
    const t = this.haTopics;
    const name = ha.name || "MagicMirror Screen";
    return {
      name: name,
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
      device: {
        identifiers: ["mmm_psc_" + t.objectId],
        name: name,
        manufacturer: "MMM-PresenceScreenControl",
        model: "Screen Switch"
      }
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
      console.error("PresenceControl: homeAssistant topics collide with mqttTopic — HA integration disabled");
      this.log("[HA] topic collision with mqttTopic — aborting HA init", "simple");
      this.haTopics = null;
      return;
    }

    const options = {
      reconnectPeriod: HA_RECONNECT_MS,
      queueQoSZero: false,
      will: { topic: t.availability, payload: HA_AVAIL_OFFLINE, retain: true, qos: HA_QOS }
    };
    if (this.config.mqttUser) { options.username = this.config.mqttUser; }
    if (this.config.mqttPassword) { options.password = this.config.mqttPassword; }

    this.haClient = mqtt.connect(this.config.mqttServer, options);

    // connect handler runs on every (re)connect — republishing discovery/availability/state is self-healing
    this.haClient.on("connect", () => {
      this.log("[HA] connected", "simple");
      if (this.config.homeAssistant.discovery) {
        this.haClient.publish(t.discovery, JSON.stringify(this.buildDiscoveryPayload()), { retain: true, qos: HA_QOS });
      }
      this.haClient.publish(t.availability, HA_AVAIL_ONLINE, { retain: true, qos: HA_QOS });
      this.publishHaState();
      this.haClient.subscribe(t.command, { qos: HA_QOS }, (err) => {
        if (err) this.log("[HA] subscribe error: " + err, "simple");
        else this.log("[HA] subscribed to " + t.command, "simple");
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
        this.log("[HA] ignoring unknown command payload: " + cmd, "simple");
        return;
      }
      // Confirmation publish: snap the switch back to reality if the command was rejected/overridden by cron windows
      this.publishHaState();
    });

    this.haClient.on("error", (err) => { this.log("[HA] connection error: " + err, "simple"); });
    this.haClient.on("close", () => { this.log("[HA] connection closed", "simple"); });
    this.haClient.on("offline", () => { this.log("[HA] offline", "simple"); });
    this.haClient.on("reconnect", () => { this.log("[HA] reconnecting", "simple"); });
  },

  publishHaState: function () {
    if (!this.haClient || !this.haTopics || typeof this.screenOn !== "boolean") return;
    const payload = this.screenOn ? HA_PAYLOAD_ON : HA_PAYLOAD_OFF;
    this.haClient.publish(this.haTopics.state, payload, { retain: true, qos: HA_STATE_QOS });
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
