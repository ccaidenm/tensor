import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite"
import process from "node:process";
import path from "node:path";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  define: {
    // BENCH_AUTO=1 npm run build auto-runs the differential on boot
    // (never in plain builds).
    __BENCH_AUTO__: JSON.stringify(process.env.BENCH_AUTO === '1'),
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },

  // The engine is a `file:`-linked workspace package — pre-bundling it
  // SNAPSHOTs its dist into .vite/deps, so a rebuilt engine never
  // reached the dev server. Excluded, Vite serves + transforms its
  // source directly, and engine edits hot-reload.
  optimizeDeps: {
    exclude: ['@tensor-editor/engine'],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
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
