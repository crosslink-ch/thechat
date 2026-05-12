import { useEffect, useRef, useState, type FormEvent } from "react";
import { create } from "zustand";
import { API_URL, api } from "../lib/api";
import { useAuthStore } from "../stores/auth";
import { requestInputBarFocus } from "../stores/input-focus";
import { useWorkspacesStore } from "../stores/workspaces";

const DEFAULT_INSTRUCTIONS = "Reply concisely in TheChat.";

const useHermesBotModalState = create(() => ({ open: false }));

export const openHermesBotModal = () =>
  useHermesBotModalState.setState({ open: true });

const closeHermesBotModal = () => {
  useHermesBotModalState.setState({ open: false });
  requestInputBarFocus();
};

function auth(token: string) {
  return { headers: { authorization: `Bearer ${token}` } };
}

export function HermesBotModal() {
  const open = useHermesBotModalState((s) => s.open);
  if (!open) return null;
  return <HermesBotModalInner />;
}

function HermesBotModalInner() {
  const token = useAuthStore((s) => s.token);
  const activeWorkspace = useWorkspacesStore((s) => s.activeWorkspace);
  const selectWorkspace = useWorkspacesStore((s) => s.selectWorkspace);

  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState(DEFAULT_INSTRUCTIONS);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [createdBotName, setCreatedBotName] = useState("");
  const [botToken, setBotToken] = useState("");
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const currentRole = activeWorkspace?.members.find(
    (m) => m.userId === useAuthStore.getState().user?.id,
  )?.role;
  const isAdmin = currentRole === "owner" || currentRole === "admin";

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeHermesBotModal();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");

    if (!token) {
      setError("Log in before adding a bot.");
      return;
    }
    if (!activeWorkspace) {
      setError("Select a workspace before adding a bot.");
      return;
    }
    if (!isAdmin) {
      setError("Only workspace admins can add Hermes bots.");
      return;
    }
    if (!name.trim()) {
      setError("Bot name is required.");
      return;
    }
    setSubmitting(true);
    try {
      const { data: bot, error: createError } = await api.bots.create.post(
        {
          kind: "hermes",
          workspaceId: activeWorkspace.id,
          name: name.trim(),
        },
        auth(token),
      );
      if (createError) {
        throw new Error((createError as any).error || "Failed to create Hermes bot");
      }

      const botId = (bot as any)?.id;
      const apiKey = (bot as any)?.apiKey;
      if (!botId) throw new Error("Hermes bot was created without an ID");
      if (!apiKey) throw new Error("Hermes bot was created without a bot token");

      const { error: connectError } = await api.bots({ botId }).hermes.patch(
        {
          defaultMode: "run",
          defaultInstructions: instructions.trim() || null,
          defaultSessionScope: "channel",
        },
        auth(token),
      );
      if (connectError) {
        throw new Error((connectError as any).error || "Failed to connect Hermes runtime");
      }

      await selectWorkspace(activeWorkspace.id);
      setCreatedBotName(name.trim());
      setBotToken(apiKey);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  };

  const setupCommand = botToken
    ? [
        `THECHAT_BASE_URL=${API_URL} \\`,
        `THECHAT_BOT_TOKEN=${botToken} \\`,
        "THECHAT_ALLOW_ALL_USERS=true \\",
        "THECHAT_POLL_INTERVAL=1.0 \\",
        "uv run --frozen hermes gateway run --replace",
      ].join("\n")
    : "";

  const copySetup = async () => {
    if (!setupCommand) return;
    await navigator.clipboard.writeText(setupCommand);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-overlay p-4 backdrop-blur-[2px] animate-fade-in" onClick={closeHermesBotModal}>
      <div className="w-full max-w-[460px] rounded-xl border border-border-strong bg-surface p-6 shadow-card animate-slide-up" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-5 text-[1.214rem] font-semibold tracking-tight text-text">Add Hermes Bot</h2>

        {botToken ? (
          <div>
            <p className="mb-3 text-[0.929rem] leading-relaxed text-text-muted">
              {createdBotName} was added. Start Hermes Gateway with this bot token:
            </p>
            <textarea
              className="mb-3 block min-h-36 w-full resize-none rounded-lg border border-border bg-base px-3.5 py-2.5 font-mono text-[0.786rem] leading-relaxed text-text outline-none"
              value={setupCommand}
              readOnly
              spellCheck={false}
            />
            <div className="mt-1 flex gap-2">
              <button
                className="block flex-1 cursor-pointer rounded-lg border border-border-strong bg-elevated px-3 py-2.5 font-[inherit] text-[0.929rem] font-medium text-text transition-colors duration-150 hover:bg-button"
                type="button"
                onClick={copySetup}
              >
                {copied ? "Copied" : "Copy Setup"}
              </button>
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

          <label className="mb-3.5 block">
            <span className="mb-1.5 block text-[0.857rem] font-medium text-text-muted">Default instructions</span>
            <textarea
              className="block min-h-20 w-full resize-y rounded-lg border border-border bg-base px-3.5 py-2.5 font-[inherit] text-[0.929rem] text-text outline-none transition-colors duration-150 placeholder:text-text-placeholder focus:border-border-focus"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
          </label>

          {error && <div className="mb-3 rounded-lg border border-error-msg-border bg-error-msg-bg px-3 py-2 text-[0.857rem] text-error-bright">{error}</div>}

          <div className="mt-1 flex gap-2">
            <button
              className="block flex-1 cursor-pointer rounded-lg border border-border-strong bg-elevated px-3 py-2.5 font-[inherit] text-[0.929rem] font-medium text-text transition-colors duration-150 hover:not-disabled:bg-button disabled:cursor-default disabled:opacity-40"
              type="submit"
              disabled={submitting}
            >
              {submitting ? "Adding..." : "Add Bot"}
            </button>
            <button
              className="cursor-pointer rounded-lg border border-border bg-raised px-3 py-2.5 font-[inherit] text-[0.929rem] text-text-muted transition-colors duration-150 hover:bg-hover hover:text-text"
              type="button"
              onClick={closeHermesBotModal}
            >
              Cancel
            </button>
          </div>
        </form>
        )}
      </div>
    </div>
  );
}
