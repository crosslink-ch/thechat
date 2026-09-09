import { loadEnv } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
const clientRoot = fileURLToPath(new URL(".", import.meta.url));
export function clientConfig(appRoot: string, web: boolean) {
  const monorepoRoot = path.resolve(clientRoot, "../..");
  const env = loadEnv(web ? "web" : "test", monorepoRoot, "");
  return {
    root: appRoot,
    publicDir: path.join(clientRoot, "public"),
    define: {
      __WEB_BUILD__: web,
      __WEB_API_URL__: JSON.stringify(process.env.THECHAT_WEB_API_URL || env.THECHAT_WEB_API_URL || ""),
      __WEB_WS_URL__: JSON.stringify(process.env.THECHAT_WEB_WS_URL || env.THECHAT_WEB_WS_URL || ""),
      __BACKEND_URL__: JSON.stringify(process.env.THECHAT_BACKEND_URL || env.THECHAT_BACKEND_URL || `http://localhost:${process.env.THECHAT_BACKEND_PORT || env.THECHAT_BACKEND_PORT || "3000"}`),
    },
    plugins: [tailwindcss(), react()],
    build: { outDir: "dist" },
    clearScreen: false,
    resolve: { dedupe: ["react", "react-dom"] },
  };
}
