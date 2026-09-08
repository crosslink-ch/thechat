import "./desktop.css";
import { mountClient } from "@thechat/client";
import type { PlatformShell } from "@thechat/client/platform/contracts";
import * as shell from "./platform/shell.desktop";
shell satisfies PlatformShell;

// Connect to standalone React DevTools in development (non-blocking).
// Vite tree-shakes this entire block out of production builds.
if (import.meta.env.DEV && !__WEB_BUILD__) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  fetch("http://localhost:8097", { signal: controller.signal, mode: "no-cors" })
    .then(() => {
      const s = document.createElement("script");
      s.src = "http://localhost:8097";
      document.head.appendChild(s);
    })
    .catch(() => {});
}

mountClient(document.getElementById("root") as HTMLElement);
