import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { error as logError, formatError } from "./log";
import "highlight.js/styles/github-dark.css";
import "katex/dist/katex.min.css";
import "./App.css";

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
