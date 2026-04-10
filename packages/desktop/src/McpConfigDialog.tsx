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

const useDialogState = create(() => ({
  open: false,
  onServerAdded: null as ((config: AppConfig) => void) | null,
}));
export const openMcpConfigDialog = (onServerAdded?: (config: AppConfig) => void) =>
  useDialogState.setState({ open: true, onServerAdded: onServerAdded ?? null });
const closeDialog = () => {
  useDialogState.setState({ open: false, onServerAdded: null });
  requestInputBarFocus();
};

type Transport = "http" | "stdio";

export function McpConfigDialog() {
  const open = useDialogState((s) => s.open);
  if (!open) return null;
  return <McpConfigDialogInner />;
}

function McpConfigDialogInner() {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<Transport>("http");

  // HTTP fields
  const [url, setUrl] = useState("");
  const [useOAuth, setUseOAuth] = useState(false);
  const [customHeaders, setCustomHeaders] = useState("");

  // Stdio fields
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [envVars, setEnvVars] = useState("");

  const [error, setError] = useState("");
  const [oauthStatus, setOauthStatus] = useState<OAuthStatus>({ phase: "idle" });
  const [connecting, setConnecting] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const isOAuthBusy =
    oauthStatus.phase !== "idle" &&
    oauthStatus.phase !== "done" &&
    oauthStatus.phase !== "error";
  const isBusy = isOAuthBusy || connecting;

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (isOAuthBusy) cancelMcpOAuthFlow();
        closeDialog();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isOAuthBusy]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Server name is required");
      return;
    }

    try {
      if (transport === "http") {
        await handleHttpSubmit(trimmedName);
      } else {
        await handleStdioSubmit(trimmedName);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      logError(`[mcp-config] Failed to configure MCP server: ${msg}`);
    }
  };

  const handleHttpSubmit = async (serverName: string) => {
    const trimmedUrl = url.trim();
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

    if (useOAuth) {
      // OAuth flow
      const credentials = await runMcpOAuthFlow(serverName, trimmedUrl, setOauthStatus);
      const serverConfig: McpServerConfig = {
        url: trimmedUrl,
        headers: { Authorization: `Bearer ${credentials.accessToken}` },
      };
      await saveAndInitialize(serverName, serverConfig, credentials.accessToken);
    } else {
      // Direct HTTP — optional custom headers
      const headers: Record<string, string> = {};
      for (const line of customHeaders.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const colonIdx = trimmed.indexOf(":");
        if (colonIdx === -1) {
          setError(`Invalid header (missing ':'): ${trimmed}`);
          return;
        }
        const key = trimmed.slice(0, colonIdx).trim();
        const value = trimmed.slice(colonIdx + 1).trim();
        if (!key) {
          setError(`Invalid header (empty name): ${trimmed}`);
          return;
        }
        headers[key] = value;
      }
      const serverConfig: McpServerConfig = { url: trimmedUrl, headers };
      await saveAndInitialize(serverName, serverConfig, null);
    }
  };

  const handleStdioSubmit = async (serverName: string) => {
    const trimmedCommand = command.trim();
    if (!trimmedCommand) {
      setError("Command is required");
      return;
    }

    const parsedArgs = args
      .split("\n")
      .map((a) => a.trim())
      .filter(Boolean);

    const env: Record<string, string> = {};
    for (const line of envVars.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) {
        setError(`Invalid env var (missing '='): ${trimmed}`);
        return;
      }
      env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
    }

    const serverConfig: McpServerConfig = {
      command: trimmedCommand,
      args: parsedArgs,
      env,
    };
    await saveAndInitialize(serverName, serverConfig, null);
  };

  const saveAndInitialize = async (
    serverName: string,
    serverConfig: McpServerConfig,
    token: string | null,
  ) => {
    setConnecting(true);
    try {
      // Save to config
      const config: AppConfig = await invoke("get_config");
      const updatedConfig: AppConfig = {
        ...config,
        mcpServers: { ...config.mcpServers, [serverName]: serverConfig },
      };
      await invoke("save_config", { config: updatedConfig });
      logInfo(`[mcp-config] Saved MCP server "${serverName}" to config`);

      // Notify caller (e.g. settings page) so UI updates immediately,
      // even if initialization below fails.
      useDialogState.getState().onServerAdded?.(updatedConfig);

      // Initialize and register tools
      const toolInfos = await invoke<McpToolInfo[]>("mcp_initialize_servers", {
        names: [serverName],
        token,
      });
      logInfo(
        `[mcp-config] MCP server "${serverName}" initialized with ${toolInfos.length} tools`,
      );
      useToolsStore.getState().addGlobalMcpTools(toolInfos);

      setTimeout(closeDialog, 600);
    } finally {
      setConnecting(false);
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
        className="w-full max-w-[500px] rounded-xl border border-border-strong bg-surface p-6 shadow-card animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-5 text-[1.214rem] font-semibold tracking-tight text-text">
          Add MCP Server
        </h2>

        <form onSubmit={handleSubmit} noValidate>
          {/* Server name */}
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
              placeholder="my-server"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isBusy}
            />
          </div>

          {/* Transport selector */}
          <div className="mb-3.5">
            <label className="mb-1.5 block text-[0.857rem] font-medium text-text-muted">
              Transport
            </label>
            <div className="flex gap-1">
              {(["http", "stdio"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTransport(t)}
                  disabled={isBusy}
                  className={`cursor-pointer rounded-lg border px-4 py-2 text-[0.857rem] font-medium transition-colors ${
                    transport === t
                      ? "border-accent bg-accent/15 text-accent"
                      : "border-border bg-base text-text-muted hover:bg-hover"
                  } disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  {t === "http" ? "HTTP" : "Stdio"}
                </button>
              ))}
            </div>
          </div>

          {/* HTTP fields */}
          {transport === "http" && (
            <>
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
                  placeholder="https://mcp.example.com/sse"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  disabled={isBusy}
                />
              </div>

              {/* Auth method */}
              <div className="mb-3.5">
                <label className="mb-1.5 block text-[0.857rem] font-medium text-text-muted">
                  Authentication
                </label>
                <div className="flex gap-1">
                  {([false, true] as const).map((isOAuth) => (
                    <button
                      key={String(isOAuth)}
                      type="button"
                      onClick={() => setUseOAuth(isOAuth)}
                      disabled={isBusy}
                      className={`cursor-pointer rounded-lg border px-3 py-1.5 text-[0.786rem] font-medium transition-colors ${
                        useOAuth === isOAuth
                          ? "border-accent bg-accent/15 text-accent"
                          : "border-border bg-base text-text-muted hover:bg-hover"
                      } disabled:cursor-not-allowed disabled:opacity-50`}
                    >
                      {isOAuth ? "OAuth" : "None / Token"}
                    </button>
                  ))}
                </div>
              </div>

              {!useOAuth && (
                <div className="mb-3.5">
                  <label
                    className="mb-1.5 block text-[0.857rem] font-medium text-text-muted"
                    htmlFor="mcp-headers"
                  >
                    Headers
                    <span className="ml-1 font-normal text-text-dimmed">(Name: value, one per line)</span>
                  </label>
                  <textarea
                    id="mcp-headers"
                    className="block max-h-[120px] min-h-[48px] w-full resize-y rounded-lg border border-border bg-base px-3.5 py-2.5 font-[inherit] text-[0.929rem] text-text outline-none transition-colors duration-150 placeholder:text-text-placeholder focus:border-border-focus"
                    placeholder={"Authorization: Bearer sk-...\nx-api-key: your-key"}
                    value={customHeaders}
                    onChange={(e) => setCustomHeaders(e.target.value)}
                    disabled={isBusy}
                    spellCheck={false}
                    rows={2}
                  />
                </div>
              )}
            </>
          )}

          {/* Stdio fields */}
          {transport === "stdio" && (
            <>
              <div className="mb-3.5">
                <label
                  className="mb-1.5 block text-[0.857rem] font-medium text-text-muted"
                  htmlFor="mcp-command"
                >
                  Command
                </label>
                <input
                  id="mcp-command"
                  className="block w-full rounded-lg border border-border bg-base px-3.5 py-2.5 font-[inherit] text-[0.929rem] text-text outline-none transition-colors duration-150 placeholder:text-text-placeholder focus:border-border-focus"
                  type="text"
                  placeholder="npx"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  disabled={isBusy}
                  spellCheck={false}
                />
              </div>

              <div className="mb-3.5">
                <label
                  className="mb-1.5 block text-[0.857rem] font-medium text-text-muted"
                  htmlFor="mcp-args"
                >
                  Arguments
                  <span className="ml-1 font-normal text-text-dimmed">(one per line)</span>
                </label>
                <textarea
                  id="mcp-args"
                  className="block max-h-[120px] min-h-[64px] w-full resize-y rounded-lg border border-border bg-base px-3.5 py-2.5 font-[inherit] text-[0.929rem] text-text outline-none transition-colors duration-150 placeholder:text-text-placeholder focus:border-border-focus"
                  placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/home/user/docs"}
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  disabled={isBusy}
                  spellCheck={false}
                  rows={3}
                />
              </div>

              <div className="mb-3.5">
                <label
                  className="mb-1.5 block text-[0.857rem] font-medium text-text-muted"
                  htmlFor="mcp-env"
                >
                  Environment Variables
                  <span className="ml-1 font-normal text-text-dimmed">(KEY=value, one per line)</span>
                </label>
                <textarea
                  id="mcp-env"
                  className="block max-h-[120px] min-h-[48px] w-full resize-y rounded-lg border border-border bg-base px-3.5 py-2.5 font-[inherit] text-[0.929rem] text-text outline-none transition-colors duration-150 placeholder:text-text-placeholder focus:border-border-focus"
                  placeholder={"API_KEY=abc123"}
                  value={envVars}
                  onChange={(e) => setEnvVars(e.target.value)}
                  disabled={isBusy}
                  spellCheck={false}
                  rows={2}
                />
              </div>
            </>
          )}

          {error && (
            <div className="mb-3 rounded-lg border border-error-msg-border bg-error-msg-bg px-3 py-2 text-[0.857rem] text-error-bright">
              {error}
            </div>
          )}

          {isOAuthBusy && <StatusIndicator status={oauthStatus} />}

          {connecting && (
            <div className="mb-3 flex items-center gap-2 rounded-lg border border-border bg-base px-3 py-2 text-[0.857rem] text-text-muted">
              <span className="inline-block size-3.5 animate-spin rounded-full border-2 border-text-dimmed border-t-accent" />
              <span>Connecting to server...</span>
            </div>
          )}

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              className="flex-1 cursor-pointer rounded-lg border border-border bg-base px-3 py-2.5 font-[inherit] text-[0.929rem] text-text-muted transition-colors duration-150 hover:bg-hover"
              onClick={() => {
                if (isOAuthBusy) cancelMcpOAuthFlow();
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
              {isBusy ? "Connecting..." : "Add Server"}
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
