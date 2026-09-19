#!/usr/bin/env bash
# Convenience launcher for the Apple TV launcher.
#
#   ./run.sh          → run the standalone release binary (UI embedded)
#   ./run.sh dev      → dev mode: `cargo tauri dev` (hot reload)
#   ./run.sh debug    → build the debug binary, serve the UI, then run it
#
# NOTE: Tauri DEBUG binaries load their UI from http://127.0.0.1:1420 —
# running one without a dev server gives a black window / "Connection
# refused". The RELEASE binary embeds the UI and runs fully standalone.
set -euo pipefail
cd "$(dirname "$0")"

CARGO="${CARGO:-$HOME/.cargo/bin/cargo}"

wait_for_port() {
  local port="$1"
  for _ in $(seq 1 100); do
    if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
      exec 3>&- 3<&- || true
      return 0
    fi
    sleep 0.2
  done
  echo "Timed out waiting for the dev server on port ${port}." >&2
  return 1
}

case "${1:-release}" in
  release)
    # `--features tauri/custom-protocol` is what `tauri build` passes under
    # the hood: it compiles in the embedded dist/ instead of loading the UI
    # from http://127.0.0.1:1420 (which would fail with "Connection refused").
    (cd src-tauri && "$CARGO" build --release --features tauri/custom-protocol)
    exec src-tauri/target/release/appletv-launcher
    ;;
  debug)
    echo "Building the debug binary…"
    (cd src-tauri && "$CARGO" build)
    echo "Serving the UI on http://127.0.0.1:1420…"
    npx vite --port 1420 --strictPort &
    VITE_PID=$!
    trap 'kill "$VITE_PID" 2>/dev/null || true' EXIT
    wait_for_port 1420
    src-tauri/target/debug/appletv-launcher
    ;;
  dev)
    exec "$CARGO" tauri dev
    ;;
  *)
    echo "usage: ./run.sh [release|debug|dev]" >&2
    exit 1
    ;;
esac

