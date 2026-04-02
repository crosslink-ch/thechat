import { useState, useEffect, useRef, type FormEvent } from "react";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { requestInputBarFocus } from "./stores/input-focus";
import {
  runMcpOAuthFlow,
  cancelMcpOAuthFlow,
  type OAuthStatus,
} from "./core/mcp-oauth";
import type { AppConfig, McpServerConfig } from "@thechat/shared";
import type { McpToolInfo } from "./core/types";
import { useToolsStore } from "./stores/tools";
import { error as logError, info as logInfo } from "./log";

const useDialogState = create(() => ({ open: false }));
export const openMcpConfigDialog = () =>
  useDialogState.setState({ open: true });
const closeDialog = () => {
  useDialogState.setState({ open: false });
  requestInputBarFocus();
};

export function McpConfigDialog() {
  const open = useDialogState((s) => s.open);
  if (!open) return null;
  return <McpConfigDialogInner />;
}

function McpConfigDialogInner() {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState<OAuthStatus>({ phase: "idle" });
  const nameRef = useRef<HTMLInputElement>(null);

  const isBusy =
    status.phase !== "idle" &&
    status.phase !== "done" &&
    status.phase !== "error";

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (isBusy) {
          cancelMcpOAuthFlow();
        }
        closeDialog();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isBusy]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");

    const trimmedName = name.trim();
    const trimmedUrl = url.trim();

    if (!trimmedName) {
      setError("Server name is required");
      return;
    }
    if (!trimmedUrl) {
      setError("Server URL is required");
      return;
    }

    try {
      new URL(trimmedUrl);
    } catch {
      setError("Please enter a valid URL");
      return;
    }

    try {
      // Run the OAuth flow
      const credentials = await runMcpOAuthFlow(
        trimmedName,
        trimmedUrl,
        setStatus,
      );

      // Save the MCP server to the app config
      const config: AppConfig = await invoke("get_config");
      const serverConfig: McpServerConfig = {
        url: trimmedUrl,
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
        },
      };

      const updatedConfig: AppConfig = {
        ...config,
        mcpServers: {
          ...config.mcpServers,
          [trimmedName]: serverConfig,
        },
      };

      await invoke("save_config", { config: updatedConfig });
      logInfo(`[mcp-config] Saved MCP server "${trimmedName}" to config`);

      // Initialize the MCP server and register tools globally
      const toolInfos = await invoke<McpToolInfo[]>("mcp_initialize_servers", {
        names: [trimmedName],
        token: credentials.accessToken,
      });
      logInfo(
        `[mcp-config] MCP server "${trimmedName}" initialized with ${toolInfos.length} tools`,
      );

      useToolsStore.getState().addGlobalMcpTools(toolInfos);

      // Close after brief delay so user sees "done" state
      setTimeout(closeDialog, 800);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      logError(`[mcp-config] Failed to configure MCP server: ${msg}`);
    }
  };

  return (
    <div
      className="fixed inset-0 z-20 flex items-center justify-center bg-overlay backdrop-blur-[2px] animate-fade-in"
      onClick={() => {
        if (!isBusy) closeDialog();
      }}
    >
      <div
        className="w-full max-w-[460px] rounded-xl border border-border-strong bg-surface p-6 shadow-card animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-5 text-[1.214rem] font-semibold tracking-tight text-text">
          Configure MCP Server
        </h2>

        <form onSubmit={handleSubmit} noValidate>
          <div className="mb-3.5">
            <label
              className="mb-1.5 block text-[0.857rem] font-medium text-text-muted"
              htmlFor="mcp-name"
            >
              Server Name
            </label>
            <input
              ref={nameRef}
              id="mcp-name"
              className="block w-full rounded-lg border border-border bg-base px-3.5 py-2.5 font-[inherit] text-[0.929rem] text-text outline-none transition-colors duration-150 placeholder:text-text-placeholder focus:border-border-focus"
              type="text"
              placeholder="clickup"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isBusy}
            />
          </div>

          <div className="mb-3.5">
            <label
              className="mb-1.5 block text-[0.857rem] font-medium text-text-muted"
              htmlFor="mcp-url"
            >
              Server URL
            </label>
            <input
              id="mcp-url"
              className="block w-full rounded-lg border border-border bg-base px-3.5 py-2.5 font-[inherit] text-[0.929rem] text-text outline-none transition-colors duration-150 placeholder:text-text-placeholder focus:border-border-focus"
              type="url"
              placeholder="https://mcp.clickup.com/s/..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={isBusy}
            />
            <p className="mt-1.5 text-[0.786rem] text-text-dimmed">
              The MCP server endpoint. OAuth will be used if the server requires
              it.
            </p>
          </div>

          {error && (
            <div className="mb-3 rounded-lg border border-error-msg-border bg-error-msg-bg px-3 py-2 text-[0.857rem] text-error-bright">
              {error}
            </div>
          )}

          {isBusy && <StatusIndicator status={status} />}

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              className="flex-1 cursor-pointer rounded-lg border border-border bg-base px-3 py-2.5 font-[inherit] text-[0.929rem] text-text-muted transition-colors duration-150 hover:bg-hover"
              onClick={() => {
                if (isBusy) cancelMcpOAuthFlow();
                closeDialog();
              }}
            >
              Cancel
            </button>
            <button
              className="flex-1 cursor-pointer rounded-lg border border-border-strong bg-elevated px-3 py-2.5 font-[inherit] text-[0.929rem] font-medium text-text transition-colors duration-150 hover:not-disabled:bg-button disabled:cursor-default disabled:opacity-40"
              type="submit"
              disabled={isBusy}
            >
              {isBusy ? "Connecting..." : "Connect"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function StatusIndicator({ status }: { status: OAuthStatus }) {
  const messages: Record<string, string> = {
    discovering: "Discovering OAuth metadata...",
    registering: "Registering client...",
    authorizing: "Opening browser for authorization...",
    "waiting-callback": "Waiting for authorization...",
    exchanging: "Exchanging token...",
    saving: "Saving configuration...",
    done: "Connected!",
  };

  const message =
    status.phase === "error"
      ? status.message
      : messages[status.phase] ?? "";

  if (!message) return null;

  const isDone = status.phase === "done";

  return (
    <div
      className={`mb-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-[0.857rem] ${
        isDone
          ? "border-green-800/40 bg-green-950/30 text-green-400"
          : "border-border bg-base text-text-muted"
      }`}
    >
      {!isDone && (
        <span className="inline-block size-3.5 animate-spin rounded-full border-2 border-text-dimmed border-t-accent" />
      )}
      {isDone && (
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d="M3 7l3 3 5-5" />
        </svg>
      )}
      <span className="min-w-0 flex-1 truncate">{message}</span>
    </div>
  );
}
