#!/usr/bin/env bash
#
# Start the Waydroid Android TV session on the current display, then sync the
# Android app tiles so Springboard can scan them.
#
#   waydroid/session-start.sh [--fullscreen]
#
# Run this from your desktop session (not via sudo). The container service
# must be running (it is started automatically by setup.sh).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FULLSCREEN=0
[[ "${1:-}" == "--fullscreen" ]] && FULLSCREEN=1

# The container service runs as root; make sure it is up before we begin.
if ! systemctl is-active waydroid-container >/dev/null 2>&1; then
  echo "starting waydroid-container…"
  if ! sudo systemctl start waydroid-container 2>/dev/null; then
    echo "error: please start the container first: sudo systemctl start waydroid-container" >&2
    exit 1
  fi
fi

# Containers are started on demand; make sure one is actually spawned.
if ! pgrep -f "lxc-start.*waydroid" >/dev/null 2>&1; then
  echo "Starting the Waydroid container…"
  sudo waydroid container start
fi

if pgrep -f "lxc-start.*waydroid" >/dev/null; then
  echo "Waydroid session already running; skipping start."
else
  # In Waydroid 1.6 the session type is a container property, not a CLI flag:
  # multi-window/freeform is the default, `waydroid show-full-ui` switches to
  # the full TV interface. Detach so it survives this shell.
  if [[ $FULLSCREEN -eq 1 ]]; then
    echo "Full-screen request noted: use 'waydroid show-full-ui' once the session is up."
  fi
  echo "Starting Waydroid TV session…"
  setsid nohup waydroid session start \
    >"${XDG_RUNTIME_DIR:-/tmp}/waydroid-session.log" 2>&1 &
fi

# Give it a moment to boot before exporting apps.
for _ in $(seq 1 60); do
  waydroid session status 2>/dev/null | grep -qiE "degraded|running" && break
  sleep 2
done

"$SCRIPT_DIR/integration/sync-apps.sh"
echo "done - Android TV session is up. Open Springboard and rescan apps."