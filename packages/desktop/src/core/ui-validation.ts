import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { parseTextSegments } from "./ui-blocks";
import { compileTsx } from "./ui-compiler";

export interface UiBlockError {
  code: string;
  error: string;
}

interface BoundaryProps {
  onError: (err: Error) => void;
  children: React.ReactNode;
}

class CaptureBoundary extends React.Component<BoundaryProps, { errored: boolean }> {
  state = { errored: false };
  static getDerivedStateFromError() {
    return { errored: true };
  }
  componentDidCatch(err: Error) {
    this.props.onError(err);
  }
  render() {
    return this.state.errored ? null : this.props.children;
  }
}

function mountAndCatchRenderError(Component: React.ComponentType): string | null {
  if (typeof document === "undefined") return null;

  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.position = "absolute";
  host.style.left = "-9999px";
  host.style.top = "-9999px";
  host.style.width = "0";
  host.style.height = "0";
  host.style.overflow = "hidden";
  host.style.pointerEvents = "none";
  document.body.appendChild(host);

  let renderError: string | null = null;
  const root = createRoot(host, {
    onUncaughtError: (err) => {
      renderError = err instanceof Error ? err.message : String(err);
    },
    onCaughtError: (err) => {
      renderError = err instanceof Error ? err.message : String(err);
    },
  });

  try {
    flushSync(() => {
      root.render(
        React.createElement(CaptureBoundary, {
          onError: (err: Error) => {
            renderError = err.message;
          },
          children: React.createElement(Component),
        }),
      );
    });
  } catch (e) {
    renderError = e instanceof Error ? e.message : String(e);
  } finally {
    try {
      root.unmount();
    } catch {
      // ignore unmount errors — we already have the render error
    }
    host.remove();
  }

  return renderError;
}

/**
 * Validate every ```tsx ui``` block in `text` by compiling it and mounting it
 * once in a detached DOM root. Returns one entry per failing block.
 *
 * Catches: syntax errors, factory-time runtime errors, missing `Component`,
 * and render-time exceptions (hook rule violations, undefined refs, etc.).
 * Does NOT catch: errors thrown inside useEffect (async) or event handlers.
 */
export function validateUiBlocks(text: string): UiBlockError[] {
  const segments = parseTextSegments(text);
  const errors: UiBlockError[] = [];

  for (const seg of segments) {
    if (seg.type !== "ui") continue;

    const compiled = compileTsx(seg.code);
    if (!compiled.ok) {
      errors.push({ code: seg.code, error: compiled.error });
      continue;
    }

    const renderErr = mountAndCatchRenderError(compiled.Component);
    if (renderErr) {
      errors.push({ code: seg.code, error: `Render error: ${renderErr}` });
    }
  }

  return errors;
}

/** Format validation failures as a user-role message for the next LLM turn. */
export function formatUiErrorsForLlm(errors: UiBlockError[]): string {
  const lines: string[] = [
    "The UI component(s) in your previous response failed to render. Produce a corrected response — keep the same overall answer, but fix the component code so it compiles and mounts without error. Do not apologize or mention the retry; just deliver the corrected response.",
    "",
  ];
  errors.forEach((e, i) => {
    lines.push(`--- Component ${i + 1} error ---`);
    lines.push(e.error);
    lines.push("");
    lines.push("Offending code:");
    lines.push("```tsx");
    lines.push(e.code);
    lines.push("```");
    lines.push("");
  });
  return lines.join("\n");
}
