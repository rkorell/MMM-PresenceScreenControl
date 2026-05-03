#!/bin/bash
# wakeup.sh - external wakeup notifier for MMM-PresenceScreenControl
# Sends a ping to the module's local socket so that an external screen-on
# event (e.g. a compositor mode change at boot) is treated as a presence event.
# Requires the module config option "treatExternalWakeupAsPresence: true".
SOCK="${XDG_RUNTIME_DIR:-/tmp}/mmm-psc-wakeup.sock"
if [ -S "$SOCK" ]; then
    echo 1 | nc -U -q0 "$SOCK" 2>/dev/null
fi
exit 0
