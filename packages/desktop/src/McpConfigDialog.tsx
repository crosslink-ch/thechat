import { useState, useEffect, useRef, type FormEvent } from "react";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { requestInputBarFocus } from "@thechat/client/stores/input-focus";
import {
  runMcpOAuthFlow,
  cancelMcpOAuthFlow,
  type OAuthStatus,
} from "./core/mcp-oauth";
import type { AppConfig, McpServerConfig } from "@thechat/shared";
import type { McpToolInfo } from "@thechat/client/core/types";
import { useToolsStore } from "./stores/tools";
import { error as logError, info as logInfo } from "@thechat/client/log";
import { Check, LoaderCircle } from "lucide-react";
import { buttonClass, inputClass, labelClass } from "@thechat/client/components/ui";


const segmentedClass = "inline-flex gap-0.5 rounded-lg border border-border bg-base p-0.5";
const segmentClass = (selected: boolean) =>
  `cursor-pointer rounded-md border-none px-3 py-1.5 font-[inherit] text-[0.857rem] font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${
    selected ? "bg-elevated text-text shadow-sm" : "bg-transparent text-text-dimmed hover:not-disabled:text-text"
  }`;

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
      className="fixed inset-0 z-20 flex items-center justify-center bg-overlay p-4 backdrop-blur-[2px] animate-overlay-in"
      onClick={() => {
        if (!isBusy) closeDialog();
      }}
    >
      <div
        className="w-full max-w-[500px] rounded-xl border border-border bg-surface/95 p-6 shadow-card backdrop-blur-2xl backdrop-saturate-150 animate-dialog-in"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-5 text-[1.071rem] font-semibold text-text">
          Add MCP Server
        </h2>

        <form onSubmit={handleSubmit} noValidate>
          {/* Server name */}
          <div className="mb-3.5">
            <label
              className={labelClass}
              htmlFor="mcp-name"
            >
              Server Name
            </label>
            <input
              ref={nameRef}
              id="mcp-name"
              className={`block ${inputClass}`}
              type="text"
              placeholder="my-server"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isBusy}
            />
          </div>

          {/* Transport selector */}
          <div className="mb-3.5">
            <label className={labelClass}>
              Transport
            </label>
            <div className={segmentedClass}>
              {(["http", "stdio"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTransport(t)}
                  disabled={isBusy}
                  className={segmentClass(transport === t)}
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
                  className={labelClass}
                  htmlFor="mcp-url"
                >
                  Server URL
                </label>
                <input
                  id="mcp-url"
                  className={`block ${inputClass}`}
                  type="url"
                  placeholder="https://mcp.example.com/sse"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  disabled={isBusy}
                />
              </div>

              {/* Auth method */}
              <div className="mb-3.5">
                <label className={labelClass}>
                  Authentication
                </label>
                <div className={segmentedClass}>
                  {([false, true] as const).map((isOAuth) => (
                    <button
                      key={String(isOAuth)}
                      type="button"
                      onClick={() => setUseOAuth(isOAuth)}
                      disabled={isBusy}
                      className={segmentClass(useOAuth === isOAuth)}
                    >
                      {isOAuth ? "OAuth" : "None / Token"}
                    </button>
                  ))}
                </div>
              </div>

              {!useOAuth && (
                <div className="mb-3.5">
                  <label
                    className={labelClass}
                    htmlFor="mcp-headers"
                  >
                    Headers
                    <span className="ml-1 font-normal text-text-dimmed">(Name: value, one per line)</span>
                  </label>
                  <textarea
                    id="mcp-headers"
                    className={`max-h-[120px] min-h-[48px] resize-y block ${inputClass}`}
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
                  className={labelClass}
                  htmlFor="mcp-command"
                >
                  Command
                </label>
                <input
                  id="mcp-command"
                  className={`block ${inputClass}`}
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
                  className={labelClass}
                  htmlFor="mcp-args"
                >
                  Arguments
                  <span className="ml-1 font-normal text-text-dimmed">(one per line)</span>
                </label>
                <textarea
                  id="mcp-args"
                  className={`max-h-[120px] min-h-[64px] resize-y block ${inputClass}`}
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
                  className={labelClass}
                  htmlFor="mcp-env"
                >
                  Environment Variables
                  <span className="ml-1 font-normal text-text-dimmed">(KEY=value, one per line)</span>
                </label>
                <textarea
                  id="mcp-env"
                  className={`max-h-[120px] min-h-[48px] resize-y block ${inputClass}`}
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
            <div className="mb-3 flex items-center gap-2 rounded-lg border border-border bg-white/[0.03] px-3 py-2 text-[0.857rem] text-text-muted">
              <LoaderCircle size={14} className="shrink-0 animate-spin text-accent" aria-hidden="true" />
              <span>Connecting to server...</span>
            </div>
          )}

          <div className="mt-5 flex gap-2">
            <button
              type="button"
              className={`flex-1 ${buttonClass("secondary", "lg")}`}
              onClick={() => {
                if (isOAuthBusy) cancelMcpOAuthFlow();
                closeDialog();
              }}
            >
              Cancel
            </button>
            <button
              className={`flex-1 ${buttonClass("primary", "lg")}`}
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
          ? "border-success-border bg-success-bg text-success-light"
          : "border-border bg-white/[0.03] text-text-muted"
      }`}
    >
      {!isDone && (
        <LoaderCircle size={14} className="shrink-0 animate-spin text-accent" aria-hidden="true" />
      )}
      {isDone && (
        <Check size={14} className="shrink-0" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1 truncate">{message}</span>
    </div>
  );
}
