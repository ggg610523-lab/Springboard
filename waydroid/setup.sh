#!/usr/bin/env bash
#
# Waydroid TV + Springboard integration - one-shot installer.
#
#   sudo bash waydroid/setup.sh [--with-autostart]
#
# What it does (idempotent, safe to re-run):
#   1. Installs `waydroid` from the Manjaro/Arch repositories.
#   2. Ensures binderfs is mounted (kernel has binder built in) and persists
#      across reboots.
#   3. Downloads the latest WayDroid-ATV Android TV images (x86_64, GApps
#      system + MAINLINE vendor) and installs them for `waydroid init`.
#   4. Re-initialises the Waydroid config against the ATV images and starts
#      the `waydroid-container` service.
#   5. Installs the lifecycle hooks and integration scripts for Springboard.
#
set -euo pipefail

WAYDROID_IMAGES_DIR="/etc/waydroid-extra/images"
ATV_REPO="WayDroid-ATV/waydroid-androidtv-builds"
ATV_ARCH="waydroid_tv_x86_64"
ATV_FLAVOUR_OPTS="GAPPS MAINLINE"          # prefer GAPPS system, MAINLINE vendor
DOWNLOAD_DIR="${DOWNLOAD_DIR:-/tmp/waydroid-atv}"
HOOKS_SRC="$(cd "$(dirname "$0")" && pwd)/hooks"
INTEG_SRC="$(cd "$(dirname "$0")" && pwd)/integration"

LOG() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
WARN() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
DONE() { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }

# ──────────────────────────────────────────────────────────────────────────
# 0. Preflight
# ──────────────────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  echo "This installer needs root. Run it as: sudo bash waydroid/setup.sh" >&2
  exit 1
fi

command -v pacman >/dev/null || { echo "pacman not found - not an Arch/Manjaro system?" >&2; exit 1; }
command -v curl >/dev/null || pacman -Sy --needed --noconfirm curl
command -v python3 >/dev/null || pacman -Sy --needed --noconfirm python

DEST_USER="${SUDO_USER:-$USER}"
DEST_HOME="$(eval echo "~${DEST_USER}")"
LOG "Installing for user: ${DEST_USER} (home: ${DEST_HOME})"
grep -q binder /proc/filesystems && DONE "kernel supports binderfs" || WARN "binderfs not visible in /proc/filesystems"

# ──────────────────────────────────────────────────────────────────────────
# 1. Install Waydroid from repos
# ──────────────────────────────────────────────────────────────────────────
if ! command -v waydroid >/dev/null; then
  LOG "Installing waydroid"
  pacman -S --needed --noconfirm waydroid
else
  DONE "waydroid already installed ($(waydroid --version 2>/dev/null | head -1 || echo unknown))"
fi

# ──────────────────────────────────────────────────────────────────────────
# 2. binderfs (binder is built into the kernel; expose /dev/*binder nodes)
#    NOTE: binder must be a character device for libgbinder. We mount binderfs
#    at /dev/binderfs and symlink the binder/hwbinder/vndbinder nodes into
#    /dev - mounting binderfs directly at /dev/binder breaks Waydroid
#    ("Can't open /dev/binder: Is a directory").
# ──────────────────────────────────────────────────────────────────────────
if ! mountpoint -q /dev/binderfs; then
  LOG "Mounting binderfs so Waydroid can talk to the binder driver"
  umount /dev/binder 2>/dev/null || true
  rmdir /dev/binder 2>/dev/null || true
  mkdir -p /dev/binderfs
  if mount -t binder binder /dev/binderfs 2>/dev/null; then
    DONE "binderfs mounted at /dev/binderfs"
  else
    WARN "could not mount binderfs now (will try again at boot via fstab)"
  fi
fi
ln -sf /dev/binderfs/binder /dev/binder
ln -sf /dev/binderfs/hwbinder /dev/hwbinder
ln -sf /dev/binderfs/vndbinder /dev/vndbinder

# Persist across reboots: tmpfiles creates the mountpoint + symlinks, fstab
# mounts the filesystem.
cat >/etc/tmpfiles.d/waydroid-binder.conf <<'EOF'
d /dev/binderfs 0755 root root -
L /dev/binder - - - - /dev/binderfs/binder
L /dev/hwbinder - - - - /dev/binderfs/hwbinder
L /dev/vndbinder - - - - /dev/binderfs/vndbinder
EOF
if ! grep -q '/dev/binderfs' /etc/fstab; then
  printf 'binder\t/dev/binderfs\tbinder\tdefaults\t0\t0\n' >>/etc/fstab
  DONE "added binderfs mount to /etc/fstab + tmpfiles"
fi

# ──────────────────────────────────────────────────────────────────────────
# 3. Download + install the WayDroid-ATV images
# ──────────────────────────────────────────────────────────────────────────
mkdir -p "$WAYDROID_IMAGES_DIR"
if [[ -s "$WAYDROID_IMAGES_DIR/system.img" && -s "$WAYDROID_IMAGES_DIR/vendor.img" ]]; then
  DONE "Waydroid-ATV images already present in $WAYDROID_IMAGES_DIR"
else
  LOG "Fetching latest WayDroid-ATV release info from GitHub"
  RELEASE_JSON="$(curl -fsSL "https://api.github.com/repos/$ATV_REPO/releases/latest")"
  TAG="$(printf '%s' "$RELEASE_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin)["tag_name"])')"
  SYSTEM_URL=""
  VENDOR_URL=""
  while IFS=$'\t' read -r name url; do
    case "$name" in
      *"-$ATV_ARCH-system.zip")
        # GAPPS ships Google Play + Widevine; only fall back to VANILLA when no
        # GAPPS build exists for this architecture.
        if [[ "$name" == *-GAPPS-* ]]; then
          SYSTEM_URL="$url"
        elif [[ -z "$SYSTEM_URL" ]]; then
          SYSTEM_URL="$url"
        fi
        ;;
      *"-$ATV_ARCH-vendor.zip") VENDOR_URL="$url" ;;
    esac
  done < <(printf '%s' "$RELEASE_JSON" | python3 -c '
import json,sys
for a in json.load(sys.stdin)["assets"]:
    if a["name"].lower().startswith("lineage-") and a["name"].endswith((".zip",)):
        print(a["name"] + "\t" + a["browser_download_url"])')

  if [[ -z "$SYSTEM_URL" || -z "$VENDOR_URL" ]]; then
    echo "Could not find system/vendor assets for $ATV_ARCH in release $TAG" >&2
    exit 1
  fi

  mkdir -p "$DOWNLOAD_DIR"
  LOG "Downloading Android TV images (tag ${TAG}) - this is ~1.2 GB total"
  for spec in "$SYSTEM_URL" "$VENDOR_URL"; do
    file="$(basename "$spec")"
    dest="$DOWNLOAD_DIR/$file"
    if [[ ! -s "$dest" ]]; then
      echo "  fetching $file"
      curl -fL --retry 3 -o "$dest" "$spec"
    fi
    echo "  extracting $file"
    python3 - "$dest" "$WAYDROID_IMAGES_DIR" <<'PYEOF'
import sys, zipfile, os, shutil
zip_path, out_dir = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(zip_path) as z:
    for name in z.namelist():
        base = os.path.basename(name)
        if base in ("system.img", "vendor.img"):
            out = os.path.join(out_dir, base)
            with z.open(name) as src, open(out + ".part", "wb") as dst:
                shutil.copyfileobj(src, dst, 16 * 1024 * 1024)
            os.replace(out + ".part", out)
            print(f"    installed {base}")
PYEOF
  done
  DONE "Android TV images installed to $WAYDROID_IMAGES_DIR"
fi

# ──────────────────────────────────────────────────────────────────────────
# 4. (Re)initialise Waydroid against the ATV images + start the container
# ──────────────────────────────────────────────────────────────────────────
LOG "Initialising Waydroid with the Android TV images"
waydroid init --force

LOG "Enabling + starting the waydroid-container service"
systemctl enable waydroid-container
systemctl restart waydroid-container
sleep 2
systemctl is-active waydroid-container >/dev/null \
  && DONE "waydroid-container is running" \
  || WARN "waydroid-container did not start - run 'systemctl status waydroid-container'"

# ──────────────────────────────────────────────────────────────────────────
# 5. Install hooks + integration for Springboard
# ──────────────────────────────────────────────────────────────────────────
LOG "Installing Waydroid lifecycle hooks"
HOOKS_DEST="$DEST_HOME/.local/share/waydroid/hooks"
mkdir -p "$HOOKS_DEST"
cp -v "$HOOKS_SRC"/* "$HOOKS_DEST"/ 2>/dev/null || true
install -m 755 "$INTEG_SRC/sync-apps.sh" "$DEST_HOME/.local/bin/sync-waydroid-apps.sh" 2>/dev/null \
  || {
    mkdir -p "$DEST_HOME/.local/bin"
    install -m 755 "$INTEG_SRC/sync-apps.sh" "$DEST_HOME/.local/bin/sync-waydroid-apps.sh"
  }
chown -R "$DEST_USER:${DEST_USER}" "$DEST_HOME/.local/share/waydroid" 2>/dev/null || true

# Springboard needs a rescan to notice new Android apps: this file just notes
# where the app cache lives so sync-apps.sh can clear it.
CACHE_DIR="$DEST_HOME/.config/appletv-launcher"
mkdir -p "$CACHE_DIR"
printf 'apps-cache.json\n' >"$CACHE_DIR/apps-cache.path"

# Optional autostart of the Waydroid TV session at login.
if [[ "${1:-}" == "--with-autostart" ]]; then
  AUTOSTART_DEST="$DEST_HOME/.config/autostart"
  mkdir -p "$AUTOSTART_DEST"
  cp "$INTEG_SRC/waydroid-tv.desktop" "$AUTOSTART_DEST/waydroid-tv.desktop"
  chown "$DEST_USER:${DEST_USER}" "$AUTOSTART_DEST/waydroid-tv.desktop"
  DONE "autostart entry installed ($AUTOSTART_DEST/waydroid-tv.desktop)"
fi

cat <<'EOF'

────────────────────────────────────────────────────────────
Waydroid TV is installed. Next steps (do these in your desktop
session, NOT as root):

  1. Start the Android TV session:
       waydroid/session-start.sh

  2. Export the Android app tiles (Netflix, Disney+, ...) so
     Springboard can scan them:
       ~/.local/bin/sync-waydroid-apps.sh   (or ./waydroid/integration/sync-apps.sh)

  3. Launch Springboard and re-scan apps (Settings -> rescan, or
     restart the launcher). Android apps appear in the
     "Android Apps (Waydroid)" row.

For a pure TV-box experience run: waydroid/session-start.sh --fullscreen
See waydroid/README.md for details, hooks and custom mounts.
────────────────────────────────────────────────────────────
EOF