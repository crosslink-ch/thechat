import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
const root = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  root,
  cacheDir: path.join(process.env.MOBILE_ARTIFACTS_DIR || path.join(os.homedir(), ".cache", "thechat", "mobile-tests"), "vite-cache"),
  plugins: [react(), tailwindcss()],
  resolve: { dedupe: ["react", "react-dom"], alias: {
    "#platform-services": path.resolve(root, "../src/platform/services.ts"),
    "#platform-shell": path.resolve(root, "../src/platform/shell.web.tsx"),
  } },
  define: { __WEB_BUILD__: true, __WEB_API_URL__: JSON.stringify("http://127.0.0.1:1"), __WEB_WS_URL__: JSON.stringify("ws://127.0.0.1:1/ws"), __BACKEND_URL__: JSON.stringify("http://127.0.0.1:1") },
  server: { host: "127.0.0.1", port: 1433, strictPort: true, fs: { allow: [path.resolve(root, "../../..")] } },
});
