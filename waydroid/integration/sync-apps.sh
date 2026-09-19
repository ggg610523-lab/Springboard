#!/usr/bin/env bash
#
# Export EVERY Waydroid Android TV app (leanback launcher apps included) as a
# .desktop entry so the Springboard launcher shows them all in the
# "Android Apps (Waydroid)" shelf.
#
# Waydroid's own user_manager only exports apps that are not leanback-only,
# which is why the TV apps (Settings, Play Store, YouTube, Prime Video, ...)
# never showed up. This script regenerates waydroid.*.desktop for every app
# reported by `waydroid app list`.
#
# Also installed to ~/.local/bin/sync-waydroid-apps.sh by setup.sh and run
# from session-start.sh after the TV session boots.
set -u

# Directory where the launcher scans .desktop files from.
DESKTOP_DIR="${DESKTOP_DIR:-$HOME/.local/share/applications}"
# Springboard caches its app list here; removing it forces a fresh scan.
SPRINGBOARD_CACHE="${SPRINGBOARD_CACHE:-$HOME/.config/appletv-launcher/apps-cache.json}"
# Waydroid dumps extracted app icons in here.
ICON_DIR="${ICON_DIR:-$HOME/.local/share/waydroid/data/icons}"

# Packages we never want on the shelf. The Android TV Remote Service tile is
# useless without a physical/phone remote.
EXCLUDE_PACKAGES=(com.google.android.tv.remote.service)

command -v waydroid >/dev/null 2>&1 || { echo "waydroid is not installed"; exit 0; }

if ! pgrep -f "lxc-start.*waydroid" >/dev/null 2>&1; then
  echo "Waydroid container is not running; start it first (sudo systemctl start waydroid-container)." >&2
  exit 1
fi

echo "Reading installed Android TV apps…"
APPS="$(
  waydroid app list 2>/dev/null |
    awk '
      /^Name: / {
        name = $0; sub(/^Name: /, "", name);
        gsub(/\r/, "", name); gsub(/[[:space:]]+$/, "", name);
      }
      /^packageName: / {
        pkg = $0; sub(/^packageName: /, "", pkg);
        gsub(/\r/, "", pkg); gsub(/[[:space:]]+$/, "", pkg);
        if (name == "") name = pkg;
        print name "\t" pkg;
        name = ""; pkg = "";
      }'
)"
if [[ -z "$APPS" ]]; then
  echo "The Android TV app list came back empty - is the session running? (waydroid show-full-ui)" >&2
  exit 1
fi

staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

while IFS=$'\t' read -r name pkg; do
  [[ -n "$name" && -n "$pkg" ]] || continue
  # Skip the packages we intentionally hide.
  hidden=0
  for bad in "${EXCLUDE_PACKAGES[@]}"; do
    [[ "$pkg" == "$bad" ]] && hidden=1
  done
  [[ $hidden -eq 1 ]] && continue

  icon=""
  for ext in png svg webp jpg; do
    if [[ -f "$ICON_DIR/$pkg.$ext" ]]; then
      icon="$ICON_DIR/$pkg.$ext"
      break
    fi
  done

  {
    printf '[Desktop Entry]\n'
    printf 'Type=Application\n'
    printf 'Name=%s\n' "$name"
    printf 'Exec=waydroid app launch %s\n' "$pkg"
    [[ -n "$icon" ]] && printf 'Icon=%s\n' "$icon"
    printf 'Categories=X-WayDroid-App;AudioVideo;\n'
    printf 'X-Purism-FormFactor=Workstation;Mobile;\n'
  } >"$staging/waydroid.$pkg.desktop"

  echo "  $name ($pkg)"
done <<<"$APPS"

count="$(find "$staging" -name 'waydroid.*.desktop' -type f | wc -l)"
if [[ "$count" -eq 0 ]]; then
  echo "No exportable apps found." >&2
  exit 1
fi

# Swap the new entries in, dropping anything no longer installed.
mkdir -p "$DESKTOP_DIR"
for old in "$DESKTOP_DIR"/waydroid.*.desktop; do
  [[ -e "$old" ]] && rm -f "$old"
done
for f in "$staging"/*.desktop; do
  mv -f "$f" "$DESKTOP_DIR/"
done

# Forget the launcher's cached scan so it rediscovers the apps on next boot.
if [[ -f "$SPRINGBOARD_CACHE" ]]; then
  rm -f "$SPRINGBOARD_CACHE"
  echo "Cleared Springboard app cache ($SPRINGBOARD_CACHE)."
fi

echo "Exported $count Android TV apps."
echo "Restart Springboard (or rescan apps) to see the Android tiles."