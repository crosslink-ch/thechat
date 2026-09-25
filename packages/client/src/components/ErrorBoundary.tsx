import { Component, type ReactNode, type ErrorInfo } from "react";
import { error as logError } from "../log";
import { buttonClass } from "./ui";

interface Props {
  children: ReactNode;
  /** Optional label to identify which boundary caught the error */
  name?: string;
}

interface State {
  hasError: boolean;
  errorMessage: string | null;
}

/**
 * React Error Boundary that catches rendering errors (like "Rendered more hooks
 * than during the previous render") and logs them with full stack traces to
 * the Tauri log file + console.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, errorMessage: null };
  }

  static getDerivedStateFromError(err: Error): State {
    return { hasError: true, errorMessage: err.message };
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    const label = this.props.name ?? "ErrorBoundary";
    const stack = err.stack ?? "(no stack)";
    const componentStack = info.componentStack ?? "(no component stack)";
    logError(
      `[${label}] React render error: ${err.message}\n` +
        `Stack: ${stack}\n` +
        `Component stack: ${componentStack}`,
    );
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="m-4 rounded-xl border border-error-msg-border bg-raised p-5 font-mono text-[0.929rem] text-error-bright">
          <div className="mb-2 font-semibold">
            Something went wrong
          </div>
          <div className="text-text-muted">
            {this.state.errorMessage}
          </div>
          <button
            onClick={() => this.setState({ hasError: false, errorMessage: null })}
            className={`mt-3 ${buttonClass("secondary", "md")}`}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
