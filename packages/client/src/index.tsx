import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { queryClient } from "./lib/query-client";
import { error as logError, formatError } from "./log";
import { initDesktopObservability } from "./lib/telemetry";
import "highlight.js/styles/github-dark.css";
import "katex/dist/katex.min.css";

export function mountClient(element: HTMLElement) {
initDesktopObservability();

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

ReactDOM.createRoot(element).render(
  <React.StrictMode>
    <ErrorBoundary name="App">
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);

}
