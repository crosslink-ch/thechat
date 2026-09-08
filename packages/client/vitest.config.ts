import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const env = loadEnv("test", here("../.."), "");
export default defineConfig({
  root: here("."),
  define: { __WEB_BUILD__: false, __WEB_API_URL__: JSON.stringify(""), __WEB_WS_URL__: JSON.stringify(""), __BACKEND_URL__: JSON.stringify(process.env.THECHAT_BACKEND_URL || env.THECHAT_BACKEND_URL || `http://localhost:${process.env.THECHAT_BACKEND_PORT || env.THECHAT_BACKEND_PORT || "3000"}`) },
  plugins: [react()],
  resolve: { alias: {
    "#platform-shell": here("../../scripts/testing/platform-shell.tsx"),
    "#platform-services": here("../../scripts/testing/platform-services.ts"),
  }, dedupe: ["react", "react-dom"] },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: [here("../client/src/test-setup.ts")],
    exclude: ["**/node_modules/**", "**/.claude/**", "**/scripts/**", "**/browser-tests/**", "**/mobile-tests/**", "**/e2e/**"],
    env,
    maxWorkers: 2,
  },
});
