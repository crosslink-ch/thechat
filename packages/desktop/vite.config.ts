import { defineConfig, mergeConfig } from "vite";
import { fileURLToPath } from "node:url";
import { clientConfig } from "@thechat/client/vite";
const root = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig(mergeConfig(clientConfig(root, false), {
  resolve: { alias: {
    "#platform-shell": fileURLToPath(new URL("./src/platform/shell.desktop.tsx", import.meta.url)),
    "#platform-services": fileURLToPath(new URL("./src/platform/services.ts", import.meta.url)),
  } },
  server: { port: 1420, strictPort: true, host: process.env.TAURI_DEV_HOST || false,
    hmr: process.env.TAURI_DEV_HOST ? { protocol: "ws", host: process.env.TAURI_DEV_HOST, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] }, },
}));
