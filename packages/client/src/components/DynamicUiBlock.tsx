import React, { Component as ReactComponent } from "react";
import { compileTsx } from "../core/ui-compiler";
import { PendingUiBlock } from "./PendingUiBlock";
import { CircleAlert } from "lucide-react";

interface ErrorBoundaryProps {
  /** When true, suppress the error UI and render the pending fallback instead. */
  suppressError?: boolean;
  fallbackCode?: string;
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

  componentDidUpdate(prev: ErrorBoundaryProps) {
    // Allow the boundary to re-render children after a retry: when the code
    // changes, the child component identity changes too, so reset.
    if (prev.children !== this.props.children && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      if (this.props.suppressError) {
        return <PendingUiBlock code={this.props.fallbackCode ?? ""} />;
      }
      return (
        <div className="my-2 rounded-lg border border-error-msg-border bg-error-msg-bg px-3.5 py-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[0.857rem] font-semibold text-error-bright">
            <CircleAlert size={14} aria-hidden="true" className="shrink-0" />
            Component render error
          </div>
          <pre className="m-0 whitespace-pre-wrap font-mono text-[0.786rem] leading-relaxed text-error-light">{this.state.error}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

interface DynamicUiBlockProps {
  code: string;
  /** When true, hide compile/render errors behind the pending-loading UI. */
  isStreaming?: boolean;
}

export const DynamicUiBlock = React.memo(function DynamicUiBlock({ code, isStreaming }: DynamicUiBlockProps) {
  const result = compileTsx(code);

  if (!result.ok) {
    if (isStreaming) {
      return <PendingUiBlock code={code} />;
    }
    return (
      <div className="my-2 rounded-lg border border-error-msg-border bg-error-msg-bg px-3.5 py-3">
        <div className="mb-1.5 flex items-center gap-1.5 text-[0.857rem] font-semibold text-error-bright">
          <CircleAlert size={14} aria-hidden="true" className="shrink-0" />
          Component error
        </div>
        <pre className="m-0 whitespace-pre-wrap font-mono text-[0.786rem] leading-relaxed text-error-light">{result.error}</pre>
      </div>
    );
  }

  const { Component } = result;

  return (
    <div className="my-2 overflow-auto rounded-lg border border-border-subtle bg-raised p-3.5">
      <UiErrorBoundary suppressError={isStreaming} fallbackCode={code}>
        <Component />
      </UiErrorBoundary>
    </div>
  );
});
