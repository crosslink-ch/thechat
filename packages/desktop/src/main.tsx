import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { error as logError, formatError } from "./log";
import "highlight.js/styles/github-dark.css";
import "katex/dist/katex.min.css";
import "./App.css";

// Connect to standalone React DevTools in development (non-blocking).
// Vite tree-shakes this entire block out of production builds.
if (import.meta.env.DEV) {
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

// Global handlers for uncaught errors — these log to the Tauri log file
// so production crashes are diagnosable.
window.addEventListener("error", (event) => {
  logError(
    `[global] Uncaught error: ${event.message}\n` +
      `Source: ${event.filename}:${event.lineno}:${event.colno}\n` +
      `Stack: ${event.error?.stack ?? "(no stack)"}`,
  );
});

window.addEventListener("unhandledrejection", (event) => {
  logError(`[global] Unhandled promise rejection: ${formatError(event.reason)}`);
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary name="App">
      <RouterProvider router={router} />
    </ErrorBoundary>
  </React.StrictMode>,
);
