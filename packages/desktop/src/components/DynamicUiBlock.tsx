import React, { Component as ReactComponent } from "react";
import { compileTsx } from "../core/ui-compiler";

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: string | null;
}

class UiErrorBoundary extends ReactComponent<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(err: Error): ErrorBoundaryState {
    return { error: err.message };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="my-2 rounded-lg border border-error-msg-border bg-error-msg-bg px-3 py-2.5">
          <div className="mb-1 text-xs font-semibold text-error-bright">Component render error</div>
          <pre className="m-0 whitespace-pre-wrap font-mono text-xs text-error-light">{this.state.error}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

export const DynamicUiBlock = React.memo(function DynamicUiBlock({ code }: { code: string }) {
  const result = compileTsx(code);

  if (!result.ok) {
    return (
      <div className="my-2 rounded-lg border border-error-msg-border bg-error-msg-bg px-3 py-2.5">
        <div className="mb-1 text-xs font-semibold text-error-bright">Component error</div>
        <pre className="m-0 whitespace-pre-wrap font-mono text-xs text-error-light">{result.error}</pre>
      </div>
    );
  }

  const { Component } = result;

  return (
    <div className="my-2 overflow-auto rounded-lg border border-border bg-raised p-3">
      <UiErrorBoundary>
        <Component />
      </UiErrorBoundary>
    </div>
  );
});
