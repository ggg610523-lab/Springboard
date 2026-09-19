#!/usr/bin/env bash
#
# Regenerate the Waydroid Android app desktop entries and refresh the
# Springboard (Apple TV launcher) app cache so new Android apps appear in the
# "Android Apps (Waydroid)" shelf.
#
# This is also installed to ~/.local/bin/sync-waydroid-apps.sh by setup.sh.
set -u

# Directory where Waydroid writes per-app .desktop files (also where
# Springboard scans them from).
DESKTOP_DIR="${DESKTOP_DIR:-$HOME/.local/share/applications}"
# Springboard caches its app list here; removing it forces a fresh scan.
SPRINGBOARD_CACHE="${SPRINGBOARD_CACHE:-$HOME/.config/appletv-launcher/apps-cache.json}"

command -v waydroid >/dev/null 2>&1 || { echo "waydroid is not installed"; exit 0; }

if ! pgrep -f "lxc-start.*waydroid" >/dev/null 2>&1; then
  echo "Waydroid container is not running; start it first (sudo systemctl start waydroid-container)." >&2
  exit 1
fi

mkdir -p "$DESKTOP_DIR"

# Drop stale entries (waydroid.show-apps replaces them anyway).
rm -f "$DESKTOP_DIR"/waydroid.*.desktop

echo "Exporting Android app desktop entries…"
# `waydroid show-apps` (no args) (re)creates a .desktop file per app.
if waydroid show-apps 2>/dev/null; then
  count="$(find "$DESKTOP_DIR" -maxdepth 1 -name 'waydroid.*.desktop' -type f | wc -l)"
  echo "Exported $count Android app entry/-ies."
else
  echo "waydroid show-apps failed - is the Android TV session running?" >&2
  exit 1
fi

# Forget the launcher's cached scan so it rediscovers the apps on next boot.
if [[ -f "$SPRINGBOARD_CACHE" ]]; then
  rm -f "$SPRINGBOARD_CACHE"
  echo "Cleared Springboard app cache ($SPRINGBOARD_CACHE)."
else
  echo "No Springboard app cache found ($SPRINGBOARD_CACHE) - nothing to clear."
fi

echo "Done. Restart Springboard (or rescan apps) to see the Android tiles."