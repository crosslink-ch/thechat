import { Component, type ReactNode, type ErrorInfo } from "react";
import { error as logError } from "../log";

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
        <div
          style={{
            padding: 20,
            color: "#f87171",
            background: "#1a1a1a",
            borderRadius: 8,
            margin: 16,
            fontFamily: "monospace",
            fontSize: "0.929rem",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 8 }}>
            Something went wrong
          </div>
          <div style={{ color: "#a1a1aa" }}>
            {this.state.errorMessage}
          </div>
          <button
            onClick={() => this.setState({ hasError: false, errorMessage: null })}
            style={{
              marginTop: 12,
              padding: "6px 16px",
              background: "#333",
              color: "#e4e4e7",
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: "0.929rem",
            }}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
