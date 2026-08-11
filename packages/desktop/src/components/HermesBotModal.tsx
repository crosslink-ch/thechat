import { useEffect, useRef, useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { create } from "zustand";
import { API_URL, api } from "../lib/api";
import { announceBotCreated } from "../lib/bot-events";
import { useAuthStore } from "../stores/auth";
import { requestInputBarFocus } from "../stores/input-focus";
import { useWorkspacesStore } from "../stores/workspaces";

type HermesBotModalState = {
  open: boolean;
  returnFocus: HTMLElement | null;
};

const useHermesBotModalState = create<HermesBotModalState>(() => ({
  open: false,
  returnFocus: null,
}));

export const openHermesBotModal = () => {
  const activeElement = document.activeElement;
  useHermesBotModalState.setState({
    open: true,
    returnFocus:
      activeElement instanceof HTMLElement && activeElement !== document.body
        ? activeElement
        : null,
  });
};

const closeHermesBotModal = () => {
  useHermesBotModalState.setState({ open: false });
};

function auth(token: string) {
  return { headers: { authorization: `Bearer ${token}` } };
}

export function HermesBotModal() {
  const open = useHermesBotModalState((state) => state.open);
  const returnFocus = useHermesBotModalState((state) => state.returnFocus);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeHermesBotModal();
      }}
    >
      {open && <HermesBotModalInner returnFocus={returnFocus} />}
    </Dialog.Root>
  );
}

function HermesBotModalInner({ returnFocus }: { returnFocus: HTMLElement | null }) {
  const token = useAuthStore((s) => s.token);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const activeWorkspace = useWorkspacesStore((s) => s.activeWorkspace);
  const selectWorkspace = useWorkspacesStore((s) => s.selectWorkspace);
  const eligibleWorkspaces = workspaces.filter(
    (workspace) => workspace.role === "owner" || workspace.role === "admin",
  );

  const [workspaceId, setWorkspaceId] = useState(
    () =>
      eligibleWorkspaces.find((workspace) => workspace.id === activeWorkspace?.id)?.id ??
      eligibleWorkspaces[0]?.id ??
      "",
  );
  const [name, setName] = useState("");
  const [integrationKind, setIntegrationKind] = useState<"hermes" | "hermes-rpc">("hermes");
  const [rpcEndpoint, setRpcEndpoint] = useState("http://127.0.0.1:8642");
  const [rpcGatewayToken, setRpcGatewayToken] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [createdBotName, setCreatedBotName] = useState("");
  const [botToken, setBotToken] = useState("");
  const [copied, setCopied] = useState(false);
  const [created, setCreated] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setWorkspaceId((current) => {
      if (eligibleWorkspaces.some((workspace) => workspace.id === current)) return current;
      return (
        eligibleWorkspaces.find((workspace) => workspace.id === activeWorkspace?.id)?.id ??
        eligibleWorkspaces[0]?.id ??
        ""
      );
    });
  }, [workspaces, activeWorkspace?.id]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");

    if (!token) {
      setError("Log in before adding a bot.");
      return;
    }
    if (!workspaceId) {
      setError("Choose a workspace where you are an owner or admin.");
      return;
    }
    if (!name.trim()) {
      setError("Bot name is required.");
      return;
    }
    setSubmitting(true);
    try {
      const request = integrationKind === "hermes-rpc"
        ? {
            kind: "hermes-rpc" as const,
            workspaceId,
            name: name.trim(),
            hermesRpc: {
              endpoint: rpcEndpoint.trim(),
              gatewayToken: rpcGatewayToken.trim() || null,
            },
          }
        : {
            kind: "hermes" as const,
            workspaceId,
            name: name.trim(),
          };
      const { data: bot, error: createError } = await api.bots.create.post(
        request,
        auth(token),
      );
      if (createError) {
        throw new Error((createError as any).error || "Failed to create Hermes bot");
      }

      const apiKey = (bot as any)?.apiKey;
      if (integrationKind === "hermes" && !apiKey) {
        throw new Error("Hermes bot was created without a bot token");
      }

      if (activeWorkspace?.id === workspaceId) {
        await selectWorkspace(workspaceId);
      }
      setCreatedBotName(name.trim());
      setBotToken(apiKey ?? "");
      setCreated(true);
      announceBotCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  };

  const envSnippet = botToken
    ? [
        `THECHAT_BASE_URL=${API_URL}`,
        `THECHAT_BOT_TOKEN=${botToken}`,
        "THECHAT_ALLOW_ALL_USERS=true",
        "",
        "# Choose one delivery mode.",
        "# Polling mode:",
        "THECHAT_POLL_INTERVAL=1.0",
        "",
        "# Webhook mode:",
        "# THECHAT_WEBHOOK_URL=https://your-hermes-gateway.example.com/thechat/webhook",
      ].join("\n")
    : "";

  const copySetup = async () => {
    if (!envSnippet) return;
    await navigator.clipboard.writeText(envSnippet);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-20 bg-overlay backdrop-blur-[2px] animate-fade-in" />
      <Dialog.Content
        asChild
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (returnFocus?.isConnected) {
            returnFocus.focus();
          } else {
            requestInputBarFocus();
          }
        }}
        onEscapeKeyDown={(event) => {
          if (submitting) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (submitting) event.preventDefault();
        }}
      >
        <div
          aria-modal="true"
          className="fixed left-1/2 top-1/2 z-20 w-[calc(100%-2rem)] max-w-[460px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border-strong bg-surface p-6 shadow-card animate-slide-up"
        >
          <Dialog.Title asChild>
            <h2 className="mb-5 text-[1.214rem] font-semibold tracking-tight text-text">Add Hermes Bot</h2>
          </Dialog.Title>
          <Dialog.Description className="sr-only">
            Choose an eligible workspace and create a Hermes bot. Its setup credential is shown once.
          </Dialog.Description>

        {created ? (
          <div>
            {integrationKind === "hermes" ? (
              <>
                <p className="mb-3 text-[0.929rem] leading-relaxed text-text-muted">
                  {createdBotName} was added. Add these variables to the Hermes Gateway .env file for this bot:
                </p>
                <p className="mb-3 text-[0.857rem] leading-relaxed text-text-muted">
                  Use polling for local or simple setups. Use webhook mode when Hermes has a reachable callback URL.
                </p>
                <textarea
                  className="mb-3 block min-h-56 w-full resize-none rounded-lg border border-border bg-base px-3.5 py-2.5 font-mono text-[0.786rem] leading-relaxed text-text outline-none"
                  value={envSnippet}
                  readOnly
                  spellCheck={false}
                />
              </>
            ) : (
              <div data-testid="hermes-rpc-created" className="mb-4 rounded-lg border border-green-500/30 bg-green-500/10 px-3.5 py-3 text-[0.857rem] leading-relaxed text-green-300">
                {createdBotName} was added as a Hermes RPC bot. Its connection token is encrypted and will not be shown again.
              </div>
            )}
            <div className="mt-1 flex gap-2">
              {integrationKind === "hermes" && (
                <button
                  className="block flex-1 cursor-pointer rounded-lg border border-border-strong bg-elevated px-3 py-2.5 font-[inherit] text-[0.929rem] font-medium text-text transition-colors duration-150 hover:bg-button"
                  type="button"
                  onClick={copySetup}
                >
                  {copied ? "Copied" : "Copy .env"}
                </button>
              )}
              <button
                className="cursor-pointer rounded-lg border border-border bg-raised px-3 py-2.5 font-[inherit] text-[0.929rem] text-text-muted transition-colors duration-150 hover:bg-hover hover:text-text"
                type="button"
                onClick={closeHermesBotModal}
              >
                Done
              </button>
            </div>
          </div>
        ) : (
        <form onSubmit={handleSubmit} noValidate>
          <fieldset className="mb-3.5 grid grid-cols-2 gap-2" aria-label="Hermes integration">
            <legend className="mb-1.5 text-[0.857rem] font-medium text-text-muted">Integration</legend>
            {([
              ["hermes", "Hermes Gateway", "Existing webhook or polling adapter"],
              ["hermes-rpc", "Hermes RPC", "Upstream hermes serve WebSocket API"],
            ] as const).map(([value, label, description]) => (
              <label key={value} className={`cursor-pointer rounded-lg border px-3 py-2.5 ${integrationKind === value ? "border-accent bg-accent/10" : "border-border bg-base"}`}>
                <span className="flex items-center gap-2 text-[0.857rem] font-medium text-text">
                  <input
                    type="radio"
                    name="hermes-integration"
                    value={value}
                    checked={integrationKind === value}
                    onChange={() => setIntegrationKind(value)}
                    className="accent-accent"
                  />
                  {label}
                </span>
                <span className="mt-1 block text-[0.714rem] leading-snug text-text-dimmed">{description}</span>
              </label>
            ))}
          </fieldset>
          <label className="mb-3.5 block">
            <span className="mb-1.5 block text-[0.857rem] font-medium text-text-muted">Workspace</span>
            <select
              aria-label="Workspace"
              className="block w-full rounded-lg border border-border bg-base px-3.5 py-2.5 font-[inherit] text-[0.929rem] text-text outline-none transition-colors duration-150 focus:border-border-focus disabled:opacity-50"
              value={workspaceId}
              onChange={(event) => setWorkspaceId(event.target.value)}
              disabled={eligibleWorkspaces.length === 0}
            >
              {eligibleWorkspaces.length === 0 ? (
                <option value="">No admin workspaces available</option>
              ) : (
                eligibleWorkspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))
              )}
            </select>
          </label>

          {integrationKind === "hermes-rpc" && (
            <div data-testid="hermes-rpc-connection-fields" className="mb-3.5 space-y-3 rounded-lg border border-border bg-base p-3">
              <label className="block">
                <span className="mb-1.5 block text-[0.857rem] font-medium text-text-muted">Hermes endpoint</span>
                <input
                  aria-label="Hermes RPC endpoint"
                  className="block w-full rounded-lg border border-border bg-raised px-3.5 py-2.5 font-mono text-[0.857rem] text-text outline-none focus:border-border-focus"
                  value={rpcEndpoint}
                  onChange={(event) => setRpcEndpoint(event.target.value)}
                  placeholder="http://127.0.0.1:8642"
                  spellCheck={false}
                  required
                />
                <span className="mt-1 block text-[0.714rem] text-text-dimmed">Base URLs and ws(s) /api/ws endpoints are accepted.</span>
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[0.857rem] font-medium text-text-muted">Gateway token (optional)</span>
                <input
                  aria-label="Hermes RPC gateway token"
                  type="password"
                  autoComplete="new-password"
                  className="block w-full rounded-lg border border-border bg-raised px-3.5 py-2.5 font-mono text-[0.857rem] text-text outline-none focus:border-border-focus"
                  value={rpcGatewayToken}
                  onChange={(event) => setRpcGatewayToken(event.target.value)}
                />
              </label>
            </div>
          )}

          <label className="mb-3.5 block">
            <span className="mb-1.5 block text-[0.857rem] font-medium text-text-muted">Bot name</span>
            <input
              ref={inputRef}
              className="block w-full rounded-lg border border-border bg-base px-3.5 py-2.5 font-[inherit] text-[0.929rem] text-text outline-none transition-colors duration-150 placeholder:text-text-placeholder focus:border-border-focus"
              type="text"
              placeholder="Koda"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          {error && (
            <div
              role="alert"
              className="mb-3 rounded-lg border border-error-msg-border bg-error-msg-bg px-3 py-2 text-[0.857rem] text-error-bright"
            >
              {error}
            </div>
          )}

          <div className="mt-1 flex gap-2">
            <button
              className="block flex-1 cursor-pointer rounded-lg border border-border-strong bg-elevated px-3 py-2.5 font-[inherit] text-[0.929rem] font-medium text-text transition-colors duration-150 hover:not-disabled:bg-button disabled:cursor-default disabled:opacity-40"
              type="submit"
              disabled={submitting || !workspaceId}
            >
              {submitting ? "Adding..." : "Add Bot"}
            </button>
            <button
              className="cursor-pointer rounded-lg border border-border bg-raised px-3 py-2.5 font-[inherit] text-[0.929rem] text-text-muted transition-colors duration-150 hover:bg-hover hover:text-text"
              type="button"
              onClick={closeHermesBotModal}
              disabled={submitting}
            >
              Cancel
            </button>
          </div>
        </form>
        )}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  );
}
