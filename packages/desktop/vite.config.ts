/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { readFileSync } from "node:fs";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

const monorepoRoot = path.resolve(__dirname, "../..");

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => {
  const web = mode === "web";
  // Web images intentionally omit src-tauri. Only desktop reads the version
  // that the release workflow stamps from its tag before building this renderer.
  const desktopReleaseVersion = web ? "" : JSON.parse(
    readFileSync(path.resolve(__dirname, "src-tauri/tauri.conf.json"), "utf8"),
  ).version;
  // Load .env from monorepo root ('' prefix = all vars, not just VITE_)
  const env = loadEnv(mode === "web" ? "web" : "test", monorepoRoot, "");

  const backendUrl =
    process.env.THECHAT_BACKEND_URL ||
    env.THECHAT_BACKEND_URL ||
    `http://localhost:${process.env.THECHAT_BACKEND_PORT || env.THECHAT_BACKEND_PORT || "3000"}`;

  return {
    define: {
      __WEB_BUILD__: web,
      __DESKTOP_RELEASE_VERSION__: JSON.stringify(desktopReleaseVersion),
      __WEB_API_URL__: JSON.stringify(process.env.THECHAT_WEB_API_URL || env.THECHAT_WEB_API_URL || ""),
      __WEB_WS_URL__: JSON.stringify(process.env.THECHAT_WEB_WS_URL || env.THECHAT_WEB_WS_URL || ""),
      __BACKEND_URL__: JSON.stringify(backendUrl),
    },
    resolve: { alias: { "#platform-shell": path.resolve(__dirname, `src/platform/shell.${web ? "web" : "desktop"}.tsx`) } },
    build: { outDir: web ? "dist-web" : "dist" },
    plugins: [tailwindcss(), react()],

    test: {
      globals: true,
      environment: "jsdom",
      setupFiles: "./src/test-setup.ts",
      exclude: ["**/node_modules/**", "**/.claude/**", "**/scripts/web-build.test.mjs"],
      env,
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
  };
});
