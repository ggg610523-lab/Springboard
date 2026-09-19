import { defineConfig } from "vite";

// Vite configuration tuned for Tauri.
// - fixed dev port so `tauri dev` can point at it
// - no obfuscated/minified class names so CSS stays predictable
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "es2022",
    minify: "esbuild",
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
});
