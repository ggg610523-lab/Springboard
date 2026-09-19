#!/usr/bin/env bash
#
# Remove Waydroid TV and the Springboard integration bits installed by
# setup.sh. Run with sudo.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo: sudo bash waydroid/uninstall.sh" >&2
  exit 1
fi

DEST_USER="${SUDO_USER:-$USER}"
DEST_HOME="$(eval echo "~${DEST_USER}")"

read -r -p "Remove the Android TV images too (~1.2 GB)? [y/N] " ans
case "$ans" in
  y | Y) rm -rf /etc/waydroid-extra/images ;;
esac

read -r -p "Remove the user data container (~6+ GB under ~/.local/share/waydroid)? [y/N] " ans
case "$ans" in
  y | Y) rm -rf "$DEST_HOME/.local/share/waydroid" ;;
esac

systemctl disable --now waydroid-container 2>/dev/null || true

echo "Removing the waydroid package"
pacman -Rns waydroid 2>/dev/null || true

# Drop the fstab binder mount and tmpfiles entry we added.
sed -i '\#^binder\t/dev/binderfs\tbinder#d' /etc/fstab
rm -f /etc/tmpfiles.d/waydroid-binder.conf

# Remove integration symlinks / autostart.
rm -f "$DEST_HOME/.local/bin/sync-waydroid-apps.sh" "$DEST_HOME/sync-waydroid-apps.sh"
rm -f "$DEST_HOME/.config/autostart/waydroid-tv.desktop"

echo "Uninstall complete. You may also delete the ATV images you downloaded."
echo "Note: /dev/binder stays mounted until reboot."