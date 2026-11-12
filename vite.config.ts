import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteExportAssets } from "./vite/exportAssets.mjs";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  // 导出的离线看板是单文件 HTML,内联的东西越小它越小 —— 见 vite/exportAssets.ts
  plugins: [react(), viteExportAssets(import.meta.dirname)],
  // Keep Vite's generated dependency cache out of node_modules. This also
  // makes worktrees and shared/read-only dependency installs predictable.
  cacheDir: ".vite-cache",

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  build: {
    // The editor and lazy-loaded ECharts bundle are intentionally substantial
    // desktop features. Keep the warning threshold aligned with those audited
    // chunks while retaining the chart split from the main startup path.
    chunkSizeWarningLimit: 750,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes("/node_modules/@codemirror/") ||
            id.includes("/node_modules/@lezer/") ||
            id.includes("/node_modules/@uiw/react-codemirror/")
          ) {
            return "sql-editor";
          }
          return undefined;
        },
      },
    },
  },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    headers: { "Content-Security-Policy": "frame-ancestors 'none'" },
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
