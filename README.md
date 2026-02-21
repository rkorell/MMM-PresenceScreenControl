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
  Click anywhere on the screen to wake up the display and reset the timer.

---

## Features

- **Presence detection via PIR sensor (GPIO), MQTT events, or both**
- **Auto-dimming and configurable timers for natural, intuitive behavior**
- **Flexible “ignore” and “always on” scheduling with cron-style time windows**
- **Visual timer bar lets you (and your users) see what’s happening**
- **Customizable screen ON/OFF commands – works on almost any system**
- **Touch/click control for screen wakeup**
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

Install the required dependencies and rebuild native modules for Electron by navigating into the module's directory and running the following command:


```bash

cd MMM-PresenceScreenControl

npm install

```

**Important:**
MMM-PresenceScreenControl uses native dependencies and requires an Electron rebuild after installation.
This is handled automatically by the postinstall script defined in package.json.
If you see any errors related to native modules or Electron versions during install,
you can manually run the included postinstall script:


```bash

./postinstall

```

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
    onCommand: "DISPLAY=:0 xrandr --output HDMI-1 --mode 1920x1200 --rotate left",
    offCommand: "DISPLAY=:0 xrandr --output HDMI-1 --off",
    counterTimeout: 120,
    autoDimmer: true,
    autoDimmerTimeout: 60,
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
  Which field in the MQTT JSON payload contains the occupancy boolean.
  (For simple MQTT sensors, this is often just `"presence"`, containing "true" or "false".)

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

      # For Wayland (on some newer systems with wlr-randr - bookworm and later...):
      onCommand: "wlr-randr --output HDMI-A-1 --on"
      offCommand: "wlr-randr --output HDMI-A-1 --off"
      often you have to mention the correct DISPLAY for proper function, as well - see Xrandr above

```

- **counterTimeout**  
  How long (in seconds) the display stays ON after the last presence event (from either sensor).

- **autoDimmer**  
  Set to `true` to dim the screen after `autoDimmerTimeout` seconds  
  (instead of turning it off right away).

- **autoDimmerTimeout**  
  How long (in seconds) before the auto-dimmer kicks in.

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
    - `colorTo`: Bar color when timer is full (usually green)
    - `colorFrom`: Bar color when timer is empty (usually red)
    - `colorCronActivation`: Bar color during always-on window (typically blue)

- **showPresenceStatus**  
  Set to `true` to show a “Presence: YES/NO” indicator above the bar.

- **debug**  
  Set the debug logging level:
    - `"off"` – no debug output
    - `"simple"` – standard info
    - `"complex"` – lots of details (useful for troubleshooting)

- **resetCountdownWidth**  
  If `true`, the always-on bar jumps to 100% width at the start of the final countdown.  
  If `false`, the bar continues smoothly from wherever it is – no sudden jumps.



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

// Minimal config for MQTT only:
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

Touch handling is **always active** - no configuration needed. Any click or touch anywhere on the screen wakes up the display and resets the presence timer.

---

## Wayland/labwc Compatibility

### VNC and Screen Power Management

On **Wayland with labwc** compositor and **wayvnc**, screen power management works natively through the `wlr-output-power-management` protocol:

- When a VNC client connects, wayvnc acquires a power-on hold (`output_acquire_power_on`), ensuring the screen stays on
- When the last VNC client disconnects, wayvnc releases the hold (`output_release_power_on`), and the screen returns to its previous state

This means: if the screen was off (PIR timeout) and you connect via VNC, the screen turns on automatically. When you close VNC, the screen goes back to off. No manual VNC disconnect commands are needed.

### Cross-Platform Design

This module supports both X11 and Wayland through configurable commands:
- `onCommand` / `offCommand`: Adapt to your display server

Simply change these config parameters - no code changes needed.

---

## GPIO on Modern Systems (Raspberry Pi 5, Debian Trixie)

### The libgpiod 2.x Problem

On newer systems (Debian 13 "Trixie", Raspberry Pi OS based on it), the GPIO library has been upgraded from libgpiod 1.x to **libgpiod 2.x**. This is a breaking API change.

**Impact:** The npm package `node-libgpiod` (used for PIR sensor access) is incompatible with:
- libgpiod 2.x (API incompatibility)
- Electron 35+ (N-API compatibility issues)

### Automatic Fallback to Python/gpiozero

MMM-PresenceScreenControl automatically detects if `node-libgpiod` is unavailable and falls back to **Python with gpiozero**:

- **pirLib.js** contains `gpiodDetect()` which checks library availability
- If unavailable, it spawns `MotionSensor.py` using gpiozero (lgpio backend)
- This works transparently - no configuration change needed

**Requirements for fallback:**
- Python 3 with gpiozero (`python3-gpiozero`)
- lgpio library (`python3-lgpio`)
- Both are typically pre-installed on Raspberry Pi OS

### Tested Configurations

| System | GPIO Library | Status |
|--------|--------------|--------|
| Debian 12 (Bookworm) + node-libgpiod | libgpiod 1.x | ✓ Works |
| Debian 13 (Trixie) + Python/gpiozero | libgpiod 2.x | ✓ Works (auto-fallback) |

---

## Troubleshooting and Known Issues

- On Raspberry Pi or ARM systems, native modules (like node-libgpiod) may require a rebuild after installation.
  See installation section for details.

- If the bar does not appear, check that `style` is set to `2` (bar), or use `0` for no graphics.

- For custom hardware or unusual OS setups, make sure `onCommand` and `offCommand` are correct.

- If you use both PIR and MQTT, presence is triggered by either ("OR" logic, not "AND").

- For advanced cron time windows, check the syntax carefully.

- **GPIO errors on Debian Trixie:** The module automatically falls back to Python/gpiozero. Check that `python3-gpiozero` and `python3-lgpio` are installed.

---

## Credits & License

Created by Dr. Ralf Korell, 2025,
with gratitude and credit to
- bugsounet/Coernel82 (MMM-Pir)
- olexs (MMM-MQTTScreenOnOff)

MIT License.

---

## Changelog

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