// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // NOTE: do NOT set WEBKIT_DISABLE_COMPOSITING_MODE / WEBKIT_DISABLE_DMABUF_RENDERER.
    // They force software rendering and make a blur-heavy UI crawl. Hardware
    // compositing works fine on Wayland/Intel here. If a specific machine ever
    // shows rendering artifacts, export one of them manually before starting:
    //   WEBKIT_DISABLE_DMABUF_RENDERER=1 appletv-launcher
    appletv_launcher_lib::run()
}


