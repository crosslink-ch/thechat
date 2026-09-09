import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  root: here("."),
  define: { __WEB_BUILD__: true, __WEB_API_URL__: JSON.stringify(""), __WEB_WS_URL__: JSON.stringify(""), __BACKEND_URL__: JSON.stringify(process.env.THECHAT_BACKEND_URL || `http://localhost:${process.env.THECHAT_BACKEND_PORT || "3000"}`) },
  plugins: [react()],
  resolve: { alias: {
    "#platform-shell": here("./src/platform/shell.web.tsx"),
    "#platform-services": here("./src/platform/services.ts"),
  }, dedupe: ["react", "react-dom"] },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: [here("../client/src/test-setup.ts")],
    exclude: ["**/node_modules/**", "**/.claude/**", "**/scripts/**", "**/browser-tests/**", "**/mobile-tests/**", "**/e2e/**"],
    env: loadEnv("test", here("../.."), ""),
    maxWorkers: 2,
  },
});
