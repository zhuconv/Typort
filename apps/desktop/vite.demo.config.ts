import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Build of the standalone, in-browser Typort editor demo, deployed to
 * GitHub Pages (https://zhuconv.github.io/Typort/).
 *
 * It reuses the desktop app's editor modules — Monaco + Shiki and
 * open-typora — but has no Tauri layer: the entry is `demo.html`, not the
 * app's `index.html`, and it loads bundled sample files instead of remote
 * sessions.
 */
export default defineConfig({
  plugins: [react()],
  // GitHub Pages serves a project site under /<repo>/.
  base: "/Typort/",
  optimizeDeps: {
    exclude: ["open-typora"],
  },
  build: {
    target: "es2022",
    outDir: "demo-dist",
    emptyOutDir: true,
    rollupOptions: {
      input: "demo.html",
    },
  },
});
