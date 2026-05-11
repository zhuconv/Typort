import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 5174 }
      : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  // typora-web is consumed from a github URL pinned to a SHA; Vite's
  // dep optimiser caches it under .vite/deps keyed by the resolved
  // path on first run. When we bump the pin, the path changes but
  // Vite's _metadata.json keeps the old reference until the cache is
  // manually deleted — meaning the editor loads stale code. Force
  // Vite to skip pre-bundling so the dep is served directly from
  // node_modules on every request.
  optimizeDeps: {
    exclude: ["typora-web"],
  },
  build: {
    target: "es2022",
    minify: false,
    sourcemap: true,
    outDir: "dist",
  },
});
