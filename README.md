# Springboard

An Apple TV (tvOS) style home screen launcher for the Linux desktop, built with
[Tauri 2](https://tauri.app), [Vite](https://vite.dev) and TypeScript.

Springboard turns your desktop into a cinematic Apple TV home screen: it
discovers the applications installed on your system, presents them as glowing
tvOS-style tiles, and launches the real apps when you select them.

## Features

- **App discovery** — scans installed `.desktop` files and displays them as
  tvOS-style tiles with real app icons.
- **Cinematic home screen** — a rotating Top Shelf hero, focusable tile rows,
  parallax / highlight effects and a full-screen splash on boot.
- **Media shelves** — IMDb-backed recommendations served on the home screen.
  Like, hide or "Play on…" titles and the engine learns your taste over time
  (a local catalogue cache and taste profile are kept on disk).
- **Search** — instant filtering of the local catalogue, with remote IMDb
  results appended when the network answers.
- **Control Centre** — volume / mute control, brightness and system actions.
- **Settings** — window preferences (fullscreen, always-on-top), autostart,
  media genre seeds, and data management (clear posters, reset taste profile).
- **Gamepad & keyboard navigation** — arrows navigate, `Enter` selects, `I`
  shows details, `M` toggles mute, `S` opens Settings, `C` opens Control
  Centre, `Esc` / `Backspace` goes back.
- **Launch feedback** — every launch attempt reports its result so the UI
  never blocks on a launched application.

## Requirements

- [Rust](https://rustup.rs) (stable) with the Tauri 2 system dependencies for
  Linux (see the [Tauri prerequisites](https://tauri.app/start/prerequisites/))
- [Node.js](https://nodejs.org) 18+ and npm

## Getting started

```bash
npm install        # install frontend dependencies
./run.sh           # build the standalone release binary and run it
```

Alternative run modes:

```bash
./run.sh dev       # cargo tauri dev — hot reload
./run.sh debug     # build a debug binary and serve the UI on :1420
```

> Note: Tauri debug binaries load the UI from `http://127.0.0.1:1420`, so a
> debug run needs the dev server (managed for you by `run.sh debug`). Release
> binaries embed the UI and run fully standalone.

## Building

```bash
npm run build      # type-check and build the frontend
npm run app:build  # produce deb / AppImage bundles
```

## Project layout

```
src/                  Frontend (TypeScript)
  ui/                 Home screen, overlay, search, settings, control centre…
  styles/             tokens, layout and tiles styling
  focus/              Focus engine for keyboard / gamepad movement
  gamepad.ts          Gamepad input handling
  api.ts              Typed bridge to the Tauri backend
  state.ts            Global store and actions
src-tauri/            Backend (Rust)
  src/apps.rs         .desktop file scanning
  src/launcher.rs     Launching real applications
  src/media.rs        IMDb catalogue and recommendation engine
  src/settings.rs     Settings persistence and autostart
  src/icons.rs        Icon discovery and the appicon:// protocol
  src/system.rs       Volume, mute and system helpers
```

## License

Private project — all rights reserved.