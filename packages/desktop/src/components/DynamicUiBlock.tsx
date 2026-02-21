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
        <div className="ui-block-error">
          <div className="ui-block-error-label">Component render error</div>
          <pre className="ui-block-error-detail">{this.state.error}</pre>
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
      <div className="ui-block-error">
        <div className="ui-block-error-label">Component error</div>
        <pre className="ui-block-error-detail">{result.error}</pre>
      </div>
    );
  }

  const { Component } = result;

  return (
    <div className="ui-block-container">
      <UiErrorBoundary>
        <Component />
      </UiErrorBoundary>
    </div>
  );
});
