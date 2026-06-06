# MMM-PresenceScreenControl

## Motivation and Project Origin

Let's be honest: everyone wants their MagicMirror to be smart and responsive –
but who wants to waste energy or keep fiddling with unreliable presence sensors?
That’s where the journey of this module began.

Previously, you had two choices:
- **MMM-Pir** (by bugsounet/Coernel82):
  Fancy, feature-rich, but a bit “heavy” and no longer maintained.
- **MMM-MQTTScreenOnOff** (by olexs):
  Simple, reliable, but missing those “extra” features and visual feedback.

Why not get the best of both worlds? That’s what MMM-PresenceScreenControl aims to do!

---

## Acknowledgments

**Big thanks** to the original creators/maintainers/keepers:
- [bugsounet](https://github.com/bugsounet) and [Coernel82](https://github.com/Coernel82) for MMM-Pir
- [olexs](https://github.com/olexs) for MMM-MQTTScreenOnOff

Without their work, this project wouldn’t exist.
If you like what you see here, consider checking out their original modules too!

---

## Why combine both modules? What was missing?

Each module had its strengths:
- MMM-Pir: cool timer bar, auto-dimming, advanced time windows, but pretty complex and tough to maintain.
- MMM-MQTTScreenOnOff: clean, robust, MQTT-friendly, but no visual feedback or “smart” features.

**By combining them, you get:**
- Support for both PIR sensors (for fast, local detection) and MQTT (for remote or radar sensors).
- A slick timer bar, auto-dimming, and flexible “ignore” or “always on” schedules.
- Simple configuration, easy installation, and a codebase that won’t break your brain.

---

## What was simplified and why?

We trimmed the fat:
- **No more camera or relay support** (if you need that, check the original modules).
- **No obfuscated code or install-time magic** – everything is here, readable, and ready to tweak.
- **Screen ON/OFF is now just a command:**
  You decide how your screen turns on or off – works for X11, Wayland, Pi, or any system.
- **Cron windows are clear and reliable:**
  Want the mirror always on for breakfast? You got it.
  Want to ignore sensor triggers at night? No problem.
- **Touch/click control:**
  Click anywhere on the screen to turn on the display (if off) and reset the presence timer.

---

## Features

- **Presence detection via PIR sensor (GPIO), MQTT events, or both**
- **Auto-dimming and configurable timers for natural, intuitive behavior**
- **Flexible “ignore” and “always on” scheduling with cron-style time windows**
- **Visual timer bar lets you (and your users) see what’s happening**
- **Customizable screen ON/OFF commands – works on almost any system**
- **Touch/click control for screen on and timer reset**
- **No more bloat – just the essentials for a happy, smart MagicMirror**

---

## Screenshots

![Presence Bar triggered by sensor](images/PresenceBarSensorTriggered.png)
![Presence Bar for "always on"](images/PresenceBarAlwaysOn.png)

---


## Key Differences, Advantages, and Limitations

### **Advantages**
- All the important features from both modules – and none of the old headaches.
- Works with fast PIRs and “slow” (radar, mmwave, etc.) sensors via MQTT.
- Clean, maintainable code. No more guessing or reverse engineering.
- Easy to update, easy to debug.

### **Limitations**
- Only “bar” (progress bar) visualization is available – sorry, no circle or semicircle.
- No support for cameras, relays, or other exotic hardware.
- You provide your own screen ON/OFF commands for your system (see below for many examples!).
- If you enable both PIR and MQTT, presence is triggered by either (logical “OR”).

---

## Installation

Navigate to your MagicMirror's modules directory and clone the repository:


```bash

cd ~/MagicMirror/modules

git clone https://github.com/rkorell/MMM-PresenceScreenControl.git

```

Install the required dependencies by navigating into the module's directory and running:


```bash

cd MMM-PresenceScreenControl

npm install

```

### Updating

```bash
cd ~/MagicMirror/modules/MMM-PresenceScreenControl
rm -rf node_modules package-lock.json
git pull
npm install
```

**Important:**
MMM-PresenceScreenControl no longer requires `electron-rebuild`.
PIR GPIO events are read via the `gpiod` CLI tool `gpiomon` (no native Node.js GPIO module).

If `gpiomon` is missing, install it with:

```bash
sudo apt install gpiod
```

If `gpiomon` is unavailable on your system, the module falls back automatically to Python/gpiozero (`MotionSensor.py`).

---

## Configuration

Plug MMM-PresenceScreenControl into your MagicMirror `config.js` like any other module.
All configuration is done via module parameters.


```js
{
  module: "MMM-PresenceScreenControl",
  position: "bottom_bar",
  config: {
    mode: "PIR_MQTT",
    pirGPIO: 4,
    mqttServer: "mqtt://localhost:1883",
    mqttTopic: "sensor/presence",
    mqttPayloadOccupancyField: "presence",
    mqttUser: "",
    mqttPassword: "",
    onCommand: "DISPLAY=:0 xrandr --output HDMI-1 --mode 1920x1200 --rotate left",
    offCommand: "DISPLAY=:0 xrandr --output HDMI-1 --off",
    counterTimeout: 120,
    startupGracePeriod: 0,
    autoDimmer: true,
    autoDimmerTimeout: 60,
    autoDimmerOpacity: 0.2,
    cronIgnoreWindows: [
      { from: "23:00", to: "05:00", days: [1,2,3,4,5] },
      { from: "01:00", to: "05:00", days: [0,6] }
    ],
    cronAlwaysOnWindows: [
      { from: "07:00", to: "08:30", days: [1,2,3,4,5] },
      { from: "07:00", to: "09:00", days: [0,6] }
    ],
    style: 2,
    colorFrom: "red",
    colorTo: "lime",
    colorCronActivation: "cornflowerblue",
    showPresenceStatus: true,
    debug: "off",
    logFileName: "",
    resetCountdownWidth: false
  }
},

```

---

### **Parameter overview – what do all these settings do?**

Here’s a breakdown of all the available options, with tips and friendly advice.

- **mode**
  `"PIR"`, `"MQTT"`, or `"PIR_MQTT"` (the default).
  - *“PIR”*: Only use the local PIR sensor.
  - *“MQTT”*: Only use remote/MQTT presence.
  - *“PIR_MQTT”*: Use both – whichever sensor triggers, presence is active.

- **pirGPIO**
  BCM pin number for your PIR sensor (if used).
  Example: `4` is typical for Pi users.

- **mqttServer**
  URL for your MQTT broker, e.g. `mqtt://localhost:1883`

- **mqttTopic**
  MQTT topic to listen for presence messages.

- **mqttPayloadOccupancyField**
  Which field in the MQTT JSON payload contains the occupancy value.
  Default: `"presence"`. The module expects the payload to be a JSON object
  and reads the named field.

  **Accepted truthy values** (case-insensitive after trim):
  - Boolean `true`
  - Number ≠ 0
  - Strings `"true"`, `"1"`, `"on"`, `"yes"`

  Everything else (including `null`, other strings, missing field) is
  treated as no presence.

  *Ignored when `mqttPayloadOn` is set (see below).*

- **mqttPayloadOn**
  Alternative to `mqttPayloadOccupancyField`. When set (non-empty), the
  module switches to **bare-string mode**: the raw MQTT message is compared
  exactly to this string (case-sensitive). Match → presence detected.
  Anything else → no presence.

  Useful for HomeAssistant default MQTT binary sensors, which publish bare
  values like `"ON"` / `"OFF"` directly without wrapping them in a JSON
  object.

  Default: empty (= field mode active).

- **mqttUser**
  Username for MQTT broker authentication. Leave empty (`""`) for brokers without authentication.

- **mqttPassword**
  Password for MQTT broker authentication. Leave empty (`""`) for brokers without authentication.

- **onCommand / offCommand**
  The command to turn your screen ON or OFF.
  *This is where the magic happens!*
  You can use just about anything that works on your system.
  Here are some great examples:

```js

      # For Raspberry Pi (vcgencmd, HDMI on/off) (NOT suitable for bookworm or later):
      onCommand: "vcgencmd display_power 1"
      offCommand: "vcgencmd display_power 0"

      # For Raspberry Pi, HDMI-CEC (for TVs with CEC support):
      onCommand: "echo 'on 0' | cec-client -s -d 1"
      offCommand: "echo 'standby 0' | cec-client -s -d 1"

      # For X11 (PC/Notebook/most Linux):
      onCommand: "xset dpms force on"
      offCommand: "xset dpms force off"

      # For Xrandr on pi (X11 with named output):
      onCommand: "xrandr --output HDMI-1 --auto"
      offCommand: "xrandr --output HDMI-1 --off"
      often you have to mention the correct DISPLAY for proper function, e.g.:
      offCommand: "DISPLAY=:0.0 xrandr --output HDMI-1 --off"
      and sometimes the "--auto" part in the onCommand references to wrong configuration. In this case you can specify the desired config within the command e.g.:
      onCommand: "DISPLAY=:0.0 xrandr --output HDMI-1 --primary --mode 2560x1440 --rate 59.951 --pos 0x0 --rotate left"

      # For systems with systemd-backlight (rare):
      onCommand: "sudo systemctl start backlight@backlight:acpi_video0"
      offCommand: "sudo systemctl stop backlight@backlight:acpi_video0"

      # For some HDMI-hat drivers (Pi hats):
      onCommand: "sudo sh -c 'echo 0 > /sys/class/backlight/rpi_backlight/bl_power'"
      offCommand: "sudo sh -c 'echo 1 > /sys/class/backlight/rpi_backlight/bl_power'"

      # For Wayland with wlr-randr (Bookworm and later):
      # Important: Use WAYLAND_DISPLAY (not DISPLAY) — wlr-randr is a Wayland tool.
      # Find your socket name: ls /run/user/1000/wayland-*
      onCommand: "WAYLAND_DISPLAY=wayland-0 wlr-randr --output HDMI-A-1 --on"
      offCommand: "WAYLAND_DISPLAY=wayland-0 wlr-randr --output HDMI-A-1 --off"
      # You can add --mode and --transform to the onCommand if needed, e.g.:
      # onCommand: "WAYLAND_DISPLAY=wayland-0 wlr-randr --output HDMI-A-1 --on --mode 1920x1080 --transform 270"

      # For Wayland with wlopm (recommended for Trixie and later):
      # wlopm uses DPMS-level power management — more robust than wlr-randr --off.
      # Install: sudo apt install wlopm
      onCommand: "wlopm --on HDMI-A-1"
      offCommand: "wlopm --off HDMI-A-1"

      # For monitors that show a "no signal" splash when the video output is cut
      # (which "breaks immersion"): use ddcutil to send the DDC/CI power command
      # — equivalent to pressing the monitor's hardware power button.
      # --skip-ddc-checks is needed because some monitors stop responding to DDC
      # queries when powered off, but still process incoming power-on commands.
      # Install: sudo apt install ddcutil
      onCommand: "ddcutil setvcp D6 1 --skip-ddc-checks"
      offCommand: "ddcutil setvcp D6 5 --skip-ddc-checks"

```

- **counterTimeout**
  How long (in seconds) the display stays ON after the last presence event (from either sensor).

- **startupGracePeriod**
  How long (in seconds) the screen stays on after module startup before the presence logic kicks in.
    - `0` (default) – screen turns off after ~1 second if nobody is detected
    - `30` – screen stays on for 30 seconds after startup, then turns off if nobody is present
  Useful for verifying that a restart completed successfully. During the grace period, sensor
  events work normally — if the PIR detects someone, the timer switches to `counterTimeout`.

- **autoDimmer**
  Set to `true` to dim the screen after `autoDimmerTimeout` seconds
  (instead of turning it off right away).

- **autoDimmerTimeout**
  How long (in seconds) before the auto-dimmer kicks in.
  Must be less than `counterTimeout` — if set too high, it is automatically clamped.

- **autoDimmerOpacity**
  Target opacity during auto-dim. Range `0.0` (fully transparent) to `1.0` (no dim).
  Default `0.2`. Out-of-range values are clamped and logged.

- **cronIgnoreWindows**
  An object-array of time-windows: {from: "HH:MM", to: "HH:MM", days: [weekday_numbers]}
  "from": start time (24h format)
  "to": end time (24h format)
  "days": which weekdays to apply (0=Sunday, 1=Monday, ..., 6=Saturday)
  During these times, all presence sensors are ignored and the screen will not turn on.
  Great for nighttime or “do not disturb” periods.

- **cronAlwaysOnWindows**
  An object-array of time-windows: {from: "HH:MM", to: "HH:MM", days: [weekday_numbers]}
  "from": start time (24h format)
  "to": end time (24h format)
  "days": which weekdays to apply (0=Sunday, 1=Monday, ..., 6=Saturday)
  During these times, the screen is forced ON, no matter what the sensors say.
  Perfect for breakfast, parties, or any time you want the mirror always awake.

- **colorFrom / colorTo / colorCronActivation**
  Customize the progress bar colors:
    - `colorTo`: Bar color when the timer is **full** (presence just detected → usually green/lime)
    - `colorFrom`: Bar color when the timer is **empty** (about to turn off → usually red)
    - `colorCronActivation`: Bar color during always-on window (typically blue)
  With the defaults (`colorFrom: "red"`, `colorTo: "lime"`), the bar starts green and gradually
  turns red as time runs out — like a traffic light.

- **showPresenceStatus**
  Set to `true` to show a “Presence: YES/NO” indicator above the bar.

- **debug**
  Set the debug logging level:
    - `"off"` – no debug output
    - `"simple"` – standard info
    - `"complex"` – lots of details (useful for troubleshooting)

- **logFileName**
  Controls where debug output goes (requires `debug` to be set to `"simple"` or `"complex"`):
    - `""` (empty string, default) – writes to `console.log`, visible in `pm2 logs`
    - `"myfile.log"` – writes to that file in the module directory, for focused debugging

- **resetCountdownWidth**
  If `true`, the always-on bar jumps to 100% width at the start of the final countdown.
  If `false`, the bar continues smoothly from wherever it is – no sudden jumps.

- **ecoMode**
  Set to `true` to additionally hide all other modules (DOM-level) while the screen is off,
  and show them again when the screen turns on. Default: `false` (opt-in).

  **Why:** Even with the display physically off, Electron keeps rendering hidden DOM
  (e.g. Newsfeed cross-fades every 20s, animated weather icons). On low-end hosts (Pi 3,
  X11) those repaints cause measurable CPU spikes. `ecoMode` adds the standard MagicMirror
  `.hidden` class to every other module via `module.hide()` — the browser then skips
  layout, paint and composite for those subtrees.

  **What it does NOT do:** It does not stop background work in other modules. Internal
  `setInterval`/`setTimeout` and network connections (MQTT, WebSockets, polling) keep
  running, so live data is up to date the moment the screen comes back on. Only render
  load is reduced.

  Module-initiated hides from other components (e.g. MMM-Remote-Control) are respected:
  `ecoMode` uses its own private lockString and never overrides foreign hides.

- **ecoModeIgnore**
  Array of module names that should remain visible while the screen is off, even with
  `ecoMode: true`. Useful for modules that should be visible the moment the screen
  wakes up by some external event (e.g. an incoming call lighting up the mirror).

  Example:
  ```
  ecoMode: true,
  ecoModeIgnore: ["MMM-FRITZ-Box-Callmonitor-py3", "clock"]
  ```

  Note: match against `module.name` (the npm/folder name), not the position alias.



---

## Usage Examples

```js
// Minimal config for PIR only:
{
  module: "MMM-PresenceScreenControl",
  position: "bottom_bar",
  config: {
    mode: "PIR",
    pirGPIO: 4,
    onCommand: "vcgencmd display_power 1",
    offCommand: "vcgencmd display_power 0"
  }
}

// Minimal config for MQTT only (JSON object payload like {"presence": true}):
{
  module: "MMM-PresenceScreenControl",
  position: "bottom_bar",
  config: {
    mode: "MQTT",
    mqttServer: "mqtt://localhost:1883",
    mqttTopic: "sensor/presence",
    mqttPayloadOccupancyField: "presence",
    onCommand: "xset dpms force on",
    offCommand: "xset dpms force off"
  }
}

// HomeAssistant default MQTT binary_sensor (bare "ON" / "OFF"):
{
  module: "MMM-PresenceScreenControl",
  position: "bottom_bar",
  config: {
    mode: "MQTT",
    mqttServer: "mqtt://homeassistant.local:1883",
    mqttTopic: "binary_sensor/presence/state",
    mqttPayloadOn: "ON",
    onCommand: "wlopm --on HDMI-A-1",
    offCommand: "wlopm --off HDMI-A-1"
  }
}

// MQTT with broker authentication:
{
  module: "MMM-PresenceScreenControl",
  position: "bottom_bar",
  config: {
    mode: "MQTT",
    mqttServer: "mqtt://your-broker:1883",
    mqttTopic: "sensor/presence",
    mqttPayloadOccupancyField: "presence",
    mqttUser: "myuser",
    mqttPassword: "mypassword",
    onCommand: "xset dpms force on",
    offCommand: "xset dpms force off"
  }
}

// Config with ignore and always-on windows:
{
  module: "MMM-PresenceScreenControl",
  position: "bottom_bar",
  config: {
    mode: "PIR_MQTT",
    pirGPIO: 4,
    mqttServer: "mqtt://localhost:1883",
    mqttTopic: "sensor/presence",
    cronIgnoreWindows: [
      { from: "23:00", to: "05:00", days: [1,2,3,4,5] },
      { from: "01:00", to: "05:00", days: [0,6] }
    ],
    cronAlwaysOnWindows: [
      { from: "07:00", to: "08:30", days: [1,2,3,4,5] },
      { from: "07:00", to: "09:00", days: [0,6] }
    ],
    onCommand: "xrandr --output HDMI-1 --auto",
    offCommand: "xrandr --output HDMI-1 --off"
  }
}
```

---

## Touch Control

MMM-PresenceScreenControl includes built-in touch/click support that works both locally and via VNC remote access.

Touch handling is **always active** — no configuration needed. A click or touch anywhere on the screen:
- **Turns on the display** if it is currently off (executes `onCommand`)
- **Resets the presence timer** to `counterTimeout`

On Wayland with wayvnc, connecting via VNC already turns on the screen automatically (see below),
so the click effectively only resets the timer. On X11, however, VNC does not control screen power,
so the click-to-wake feature is essential for remote access.

---

## Wayland/labwc Compatibility

### VNC and Screen Power Management

On **Wayland with labwc** compositor and **wayvnc**, screen power management works natively through the `wlr-output-power-management` protocol:

- When a VNC client connects, wayvnc acquires a power-on hold (`output_acquire_power_on`), ensuring the screen stays on
- When the last VNC client disconnects, wayvnc releases the hold (`output_release_power_on`), and the screen returns to its previous state

This means: if the screen was off (PIR timeout) and you connect via VNC, the screen turns on automatically. When you close VNC, the screen goes back to off. No manual VNC disconnect commands are needed.

**Known issue:** On some occasions, disconnecting from VNC does not reliably trigger the screen-off
transition. The screen may stay on until the next PIR timeout cycle turns it off. This issue is
intermittent and not yet reproducible. If you experience this, simply wait for the normal presence
timeout to turn off the screen.

### External Wakeup Hook (optional)

In some setups, a system service may force the display on at boot — for example, a Wayland
compositor mode toggle to work around a firmware bug. When this happens behind the module's back,
the screen is on but the module's internal state still says "off, no presence" — the timer bar
stays red and does not count down until the next real presence event.

To resync state in such cases, the module can listen on a local Unix socket and treat any
incoming ping as a presence event (same effect as a touch/click).

**Enable in your config:**

```js
treatExternalWakeupAsPresence: true
```

**Trigger from your script (e.g. a systemd `ExecStart`) by calling the bundled helper:**

```bash
~/MagicMirror/modules/MMM-PresenceScreenControl/wakeup.sh
```

The helper finds the socket itself; you do not configure path names. The socket lives in
`$XDG_RUNTIME_DIR` (typically `/run/user/<uid>/`), with a fallback to `/tmp`. The default value
of `treatExternalWakeupAsPresence` is `false`, so existing installations are not affected.

### Cross-Platform Design

This module supports both X11 and Wayland through configurable commands:
- `onCommand` / `offCommand`: Adapt to your display server

Simply change these config parameters — no code changes needed.

---

## Notification API

MMM-PresenceScreenControl integrates with other MagicMirror² modules via standard
notifications, so you can wire it into broader automations (room sensors, voice
assistants, smart-home bridges, …) without writing custom IPC.

### Outgoing — emitted by this module

| Notification | Payload | Fired when |
|--------------|---------|------------|
| `MMM_PSC-USER_PRESENCE` | `true` / `false` | The combined presence state changes (any sensor or touch) |
| `MMM_PSC-SCREEN_POWERSTATUS` | `true` / `false` | The physical screen turns on or off |

Both notifications are emitted exactly on state transitions — no spam on every poll.

### Incoming — consumed by this module

| Notification | Effect |
|--------------|--------|
| `MMM_PSC-WAKEUP` | Same as a touch: turns the screen on and resets the presence timer |
| `MMM_PSC-END` | Forces the screen off immediately (counter and dim state are cleared) |
| `MMM_PSC-LOCK` | Freezes presence handling — sensor events are tracked internally but no longer change screen state |
| `MMM_PSC-UNLOCK` | Resumes normal presence handling and re-evaluates the current sensor state |

Example: another module can wake the mirror when a doorbell event arrives:

```js
this.sendNotification("MMM_PSC-WAKEUP");
```

`LOCK` / `UNLOCK` are useful when an external system temporarily owns the display
(e.g. a video stream during a call). `END` is the clean way to force-off the screen
from outside without touching `offCommand` directly — the module's internal state
stays consistent.

---

## GPIO on Modern Systems (Raspberry Pi 5, Debian Trixie)

MMM-PresenceScreenControl uses `gpiomon` from `gpiod` for PIR edge detection.

**Benefits:**
- No native Node.js GPIO dependency
- No `electron-rebuild` required
- Works with modern libgpiod setups (including libgpiod 2.x)

The module auto-selects the GPIO chip:
- Raspberry Pi 5: `gpiochip4`
- Other systems: `gpiochip0` (or first available `/dev/gpiochip*`)

### Automatic fallback to Python/gpiozero

If `gpiomon` is not installed or no GPIO chip is available, the module falls back to Python/gpiozero (`MotionSensor.py`).

**Fallback requirements:**
- Python 3 with gpiozero (`python3-gpiozero`)
- lgpio backend (`python3-lgpio`)

---

## Troubleshooting and Known Issues

- For PIR mode, install `gpiod` so `gpiomon` is available (`sudo apt install gpiod`).

- If the bar does not appear, check that `style` is set to `2` (bar), or use `0` for no graphics.

- For custom hardware or unusual OS setups, make sure `onCommand` and `offCommand` are correct.

- If you use both PIR and MQTT, presence is triggered by either ("OR" logic, not "AND").

- For advanced cron time windows, check the syntax carefully.

- **GPIO errors on Debian Trixie:** Ensure `gpiomon` is installed (`gpiod` package). If unavailable, check fallback dependencies `python3-gpiozero` and `python3-lgpio`.

---

## Credits & License

Created by Dr. Ralf Korell, 2025,
with gratitude and credit to
- bugsounet/Coernel82 (MMM-Pir)
- olexs (MMM-MQTTScreenOnOff)
- [KristjanESPERANTO](https://github.com/KristjanESPERANTO) for the gpiomon refactor ([PR #2](https://github.com/rkorell/MMM-PresenceScreenControl/pull/2))

MIT License.

---

## Changelog

### v1.5.0 (09.03.2026)

**Logging, efficiency, and startup improvements**

- New parameter `logFileName` (default: `""`): Controls where debug output goes.
  Empty string (default) writes to `console.log` (visible in `pm2 logs`).
  Set to a filename (e.g. `"debug.log"`) to write to a dedicated file in the module directory.
  **Breaking change:** In v1.4.0, debug output always went to a local file and was not visible
  in `pm2 logs`. Now it defaults to `console.log`. Set `logFileName` to restore the old behavior.
- Improved cron monitor efficiency: No longer sends presence updates to the frontend every second
  when nothing has changed. Updates are now only sent on state transitions (entering/leaving
  cron windows) and during always-on countdown display. This eliminates unnecessary DOM rebuilds
  when the screen is off.
- New parameter `startupGracePeriod` (default: `0`): Seconds to keep the screen on after module
  startup before presence logic kicks in. Set to `0` for immediate behavior (screen off after ~1s
  if nobody present). Useful for verifying that a restart completed successfully.
  Suggested by [@htilburgs](https://github.com/htilburgs).
- Updated Wayland screen command examples: Added `wlopm` (recommended for Trixie+) and corrected
  `wlr-randr` examples to use `WAYLAND_DISPLAY` instead of `DISPLAY`.
- Fixed: Screen on/off commands were executed every second during always-on and ignore windows
  instead of only on state transitions. Added screen state tracking to prevent redundant command
  execution.
- Fixed: `autoDimmerTimeout` is now automatically clamped to `counterTimeout - 1` if set too high.
- Removed dead code: unused variables from earlier versions, unused CSS class `.psc-overlay`.

---

### v1.4.0 (08.03.2026)

**GPIO refactor & dependency cleanup**

- Replaced native `node-libgpiod` access with `gpiomon` (`gpiod` CLI tools); compatible with libgpiod 1.x and 2.x.
  Contributed by [@KristjanESPERANTO](https://github.com/KristjanESPERANTO) in [PR #2](https://github.com/rkorell/MMM-PresenceScreenControl/pull/2).
- Removed the `postinstall` electron rebuild flow entirely.
- PIR mode now works without native Node.js rebuilds.
- Kept automatic fallback to Python/gpiozero when `gpiomon` is unavailable.
- Fixed log spam: routed all runtime `console.log` calls through the debug system (`simple`/`complex` levels).
- Renamed log prefix from `[MMM-Pir]` to `[PresenceScreenControl]`.
- Fixed startup behavior: screen now turns off after ~1 second if no presence is detected at startup.
  Previously, the screen stayed on indefinitely until the first sensor event.
  Reported by [@htilburgs](https://github.com/htilburgs).
- Removed `package-lock.json` from repository tracking (added to `.gitignore`).
  Prevents `git pull` conflicts after `npm install`.
  Reported by [@htilburgs](https://github.com/htilburgs).

---

### v1.3.1 (06.03.2026)

**Dependency cleanup: zero vulnerabilities**

- Removed `@electron/rebuild` from `optionalDependencies`. It is now installed on-demand
  by the postinstall script only when `node-libgpiod` is present (Bookworm with libgpiod 1.x).
  This eliminates all npm deprecation warnings and 7 of 8 audit vulnerabilities that were caused
  by transitive build-time dependencies (tar, glob, rimraf, minimatch, etc.).
- Upgraded `mqtt` dependency from v4 to v5. The MQTT client API is fully backwards-compatible;
  no configuration changes required. mqtt v5 eliminates the remaining minimatch vulnerability
  via updated `help-me` dependency.
- Result: `npm install` now reports **0 vulnerabilities** and **0 deprecation warnings**,
  down from 8 vulnerabilities and 6 warnings. Package count reduced from 181 to 47.

---

### v1.3.0 (03.03.2026)

**New: MQTT broker authentication**

Added support for MQTT brokers that require username/password authentication.
Two new optional config parameters: `mqttUser` and `mqttPassword`.
Credentials are passed to the MQTT client only when configured (non-empty).
Fully backwards-compatible — existing configurations without these parameters continue to work unchanged.

Closes [#1](https://github.com/rkorell/MMM-PresenceScreenControl/issues/1).

---

### v1.2.0 (21.02.2026)

**Removed: VNC Disconnect & Double-Click**

The `vncDisconnectCommand` parameter and double-click screen shutdown have been removed.

**Why?** wayvnc (0.9.1+) natively manages screen power via the `wlr-output-power-management` Wayland protocol:
- VNC client connects → wayvnc acquires power-on hold → screen turns on
- Last VNC client disconnects → wayvnc releases hold → screen returns to previous state

The manual VNC disconnect workaround (double-click → disconnect VNC → screen off) is no longer needed. Touch/click now only wakes up the screen and resets the timer.

#### Migration from v1.1.x

1. **Remove `vncDisconnectCommand` from your config** (or leave it - it's ignored)
2. Touch behavior is now single-click only (wakeup/timer reset)

---

### v1.1.0 (13.02.2026)

**Major Changes: Touch Simplification & GPIO Fallback**

1. **Removed: `touchMode` parameter (0-3)**
   - Touch handling is now always active with fixed behavior (click = wakeup)

2. **New: Automatic GPIO fallback for Debian Trixie**
   - `pirLib.js` now auto-detects if `node-libgpiod` is unavailable
   - Falls back to Python/gpiozero transparently
   - Supports both Debian 12 (Bookworm) and Debian 13 (Trixie)

3. **New: `touchPresence` mechanism in node_helper**
   - Separate presence flag for click events (vs. PIR/MQTT)
   - Auto-timeout after 100ms allows countdown to proceed

---

### v1.0.0 (Initial Release)

- Combined features from MMM-Pir and MMM-MQTTScreenOnOff
- PIR sensor support (GPIO via node-libgpiod)
- MQTT presence detection
- Auto-dimming with configurable timeout
- Cron-based ignore and always-on windows
- Visual timer bar with color gradient
- Touch override modes (0-3)
- Configurable screen ON/OFF commands
