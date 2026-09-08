import { defineConfig, mergeConfig } from "vite";
import { fileURLToPath } from "node:url";
import { clientConfig } from "@thechat/client/vite";
const root = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig(mergeConfig(clientConfig(root, true), {
  resolve: { alias: {
    "#platform-shell": fileURLToPath(new URL("./src/platform/shell.web.tsx", import.meta.url)),
    "#platform-services": fileURLToPath(new URL("./src/platform/services.ts", import.meta.url)),
  } },
  server: { port: 1422, strictPort: true,  },
}));
