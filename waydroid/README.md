# Waydroid TV for Springboard

Installs [Waydroid](https://waydro.id) with an **Android TV (LineageOS 23 /
Android 15-based) image** from the
[WayDroid-ATV builds](https://github.com/WayDroid-ATV/waydroid-androidtv-builds),
then integrates it with the Springboard launcher so the Android apps
(Netflix, Disney+, YouTube, …) show up as tiles in their own
**"Android Apps (Waydroid)"** shelf and launch straight from the home screen.

> Waydroid runs a full Android system in an LXC container, so Android apps run
> natively on this machine. These ATV builds include GApps and Widevine L3
> for x86-64, so streaming apps (DRM content) work.

## System requirements

- Manjaro / Arch (this folder was built and verified against a Manjaro system)
- Kernel with binderfs built in (`CONFIG_ANDROID_BINDERFS=y`); **no** third
  party DKMS binder module needed
- Intel/AMD GPU for GL/VA-API passthrough (this machine: Intel UHD 620)
- ~4 GB free RAM (Android 13 container) and ~8 GB free disk
- A Wayland session (X11 partially works, but Wayland is what Waydroid is
  tested against)

## Install

```bash
sudo bash waydroid/setup.sh
```

This one command:

1. Installs `waydroid` from the Manjaro repositories
2. Mounts binderfs (`mount -t binder binder /dev/binder`) and persists it in
   `/etc/fstab` + a systemd-tmpfiles rule
3. Downloads the latest WayDroid-ATV `x86_64` images (~1.2 GB: GApps system +
   MAINLINE vendor) from GitHub releases and installs them under
   `/etc/waydroid-extra/images/`
4. Runs `waydroid init --force` and starts the `waydroid-container` service
5. Installs the lifecycle hooks and integration scripts for Springboard

Then, from your normal desktop session (Wayland):

```bash
waydroid/session-start.sh            # boot the Android TV container + session
~/.local/bin/sync-waydroid-apps.sh   # export Android app .desktop entries
```

Launch Springboard and (if needed) rescan apps. Android apps appear in the
**Android Apps (Waydroid)** shelf; open a tile to start that Android app in its
own window.

### Auto-start on login (optional)

```bash
sudo bash waydroid/setup.sh --with-autostart
```

or copy `waydroid/integration/waydroid-tv.desktop` into
`~/.config/autostart/`. The session then boots at login and the app tiles stay
in sync.

### Uninstall

```bash
sudo bash waydroid/uninstall.sh
```

## What's in here

| Path | What it does |
| --- | --- |
| `setup.sh` | Privileged one-shot installer (binderfs, pacman, ATV images, container service, hooks). Safe to re-run. |
| `session-start.sh` | Starts the Android TV session in your desktop session and syncs apps afterwards. `--fullscreen` runs the full Android TV UI instead of multi-window. |
| `integration/sync-apps.sh` | Re-exports `waydroid.*.desktop` entries and clears the Springboard app cache so new Android apps show up. Installed to `~/.local/bin/` by setup. |
| `integration/waydroid-tv.desktop` | Optional autostart entry. |
| `hooks/` | Waydroid lifecycle hooks, copied to `~/.local/share/waydroid/hooks/` on install. |
| `hooks/post_boot` | Runs *inside* the Android container after boot: disables the TV sleep/screensaver timeout. |
| `hooks/custom_mounts` | Applies `custom_mounts.txt` bind mounts into the container on start. |
| `custom_mounts.txt` | Template for bind-mounting host folders into Android (e.g. the repo into `/sdcard/Springboard`). |
| `uninstall.sh` | Removes packages, images, mounts, hooks and autostart. |

## How it integrates with Springboard

- Waydroid exports each installed Android app as a `.desktop` file named
  `waydroid.com.<package>.desktop` in `~/.local/share/applications/`.
- Springboard's scanner already reads that directory and **flags
  `waydroid.*` apps** with `isWaydroid=true`.
- `src/layout.ts` puts those apps on their own **Android Apps** shelf, separate
  from the Linux app rows.
- Launching a tile runs the app's `.desktop` `Exec=` (via gtk-launch/gio),
  which opens that single Android app in its own window - no need to see the
  full Android TV home.
- `sync-apps.sh` clears `~/.config/appletv-launcher/apps-cache.json` so the
  launcher does a fresh scan and picks up newly installed Android apps.

### Streaming apps and DRM

The `GAPPS` system image ships with Widevine L3, so mainstream streaming apps
(Netflix, Disney+, Prime Video, YouTube, …) should be able to play DRM content.
Google account sign-in may require Google Play certification; see the
[WayDroid-ATV README](https://github.com/WayDroid-ATV/waydroid-androidtv-builds).

## Runtime model (two ways to use it)

- **Multi-window (default)** - Springboard is your home screen; each Android
  app opens in its own desktop window when you select its tile. Desktop apps
  and Android apps coexist.
- **Full TV-box** - `waydroid/session-start.sh --fullscreen` shows the whole
  Android TV UI full screen; run it on a dedicated device where Android TV is
  the entire experience.

## Troubleshooting

- **`/dev/binder` missing / container won't start** — check the mount:
  `mount | grep binder`. If absent: `sudo mount -t binder binder /dev/binder`.
- **No Android rows appear in Springboard** — run `sync-apps.sh` (export
  entries) and confirm `ls ~/.local/share/applications/waydroid.*` lists files.
- **Session dies with the terminal** — use `session-start.sh` (it detaches via
  `setsid nohup`).
- **Video won't play (DRM error)** — check DriveDroid/Widevine; some apps
  require Play certification.