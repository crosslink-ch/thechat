import { useCallback, useEffect, useMemo, useState } from "react";
import type { OwnedBot, WorkspaceListItem } from "@thechat/shared";
import { api } from "../lib/api";
import { BOT_CREATED_EVENT } from "../lib/bot-events";
import { edenErrorMessage } from "../lib/eden";
import { openHermesBotModal } from "../components/HermesBotModal";
import { useAuthStore } from "../stores/auth";
import { useWorkspacesStore } from "../stores/workspaces";

function auth(token: string) {
  return { headers: { authorization: `Bearer ${token}` } };
}

type Notice = { kind: "success" | "error"; text: string };
type ConfirmActionKind = "rotate-key" | "revoke-key" | "rotate-secret" | "delete";
type ConfirmAction = { botId: string; action: ConfirmActionKind } | null;
type RevealedApiKey = { botId: string; value: string } | null;

type WorkspaceRow = {
  id: string;
  name: string;
  role: WorkspaceListItem["role"] | null;
  connected: boolean;
};

function botKindLabel(kind: OwnedBot["kind"]) {
  if (kind === "hermes-rpc") return "Direct Hermes";
  return kind === "hermes" ? "Hermes" : "Webhook";
}

function BotKindBadge({ kind }: { kind: OwnedBot["kind"] }) {
  return (
    <span className="rounded-full border border-border bg-base px-2 py-0.5 text-[0.714rem] font-semibold uppercase tracking-wide text-text-dimmed">
      {botKindLabel(kind)}
    </span>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-raised/40 p-4">
      <div className="mb-4">
        <h3 className="text-[0.929rem] font-semibold text-text">{title}</h3>
        {description && (
          <p className="mt-1 text-[0.786rem] leading-relaxed text-text-dimmed">
            {description}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}

export function BotsManageRoute() {
  const token = useAuthStore((state) => state.token);
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const activeWorkspace = useWorkspacesStore((state) => state.activeWorkspace);
  const selectWorkspace = useWorkspacesStore((state) => state.selectWorkspace);

  const [bots, setBots] = useState<OwnedBot[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [name, setName] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [attachmentAccess, setAttachmentAccess] = useState(true);
  const [showSecretForBotId, setShowSecretForBotId] = useState<string | null>(null);
  const [revealedApiKey, setRevealedApiKey] = useState<RevealedApiKey>(null);
  const [copied, setCopied] = useState<{ botId: string; label: string } | null>(null);

  const selectedBot = useMemo(
    () => bots.find((bot) => bot.id === selectedId) ?? null,
    [bots, selectedId],
  );

  const loadBots = useCallback(async () => {
    if (!token) {
      setBots([]);
      setSelectedId(null);
      setLoading(false);
      return;
    }

    try {
      const { data, error } = await api.bots.list.get(auth(token));
      if (error) throw new Error(edenErrorMessage(error, "Failed to load bots"));
      const nextBots = (Array.isArray(data) ? data : []) as OwnedBot[];
      setBots(nextBots);
      setSelectedId((current) =>
        current && nextBots.some((bot) => bot.id === current)
          ? current
          : nextBots[0]?.id ?? null,
      );
      setNotice(null);
    } catch (error) {
      setNotice({
        kind: "error",
        text: error instanceof Error ? error.message : "Failed to load bots",
      });
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void loadBots();
    const refresh = () => void loadBots();
    window.addEventListener(BOT_CREATED_EVENT, refresh);
    return () => window.removeEventListener(BOT_CREATED_EVENT, refresh);
  }, [loadBots]);

  useEffect(() => {
    if (!selectedBot) return;
    setName(selectedBot.name);
    setWebhookUrl(selectedBot.webhookUrl ?? "");
    setAttachmentAccess(selectedBot.attachmentAccess);
    setConfirmAction(null);
    setCopied(null);
    setNotice(null);
  }, [selectedBot?.id]);

  const isConfirming = (action: ConfirmActionKind) =>
    confirmAction?.botId === selectedBot?.id && confirmAction?.action === action;

  const workspaceRows = useMemo<WorkspaceRow[]>(() => {
    if (!selectedBot) return [];
    const connectedIds = new Set(selectedBot.workspaces.map((workspace) => workspace.id));
    const rows = new Map<string, WorkspaceRow>();

    for (const workspace of workspaces) {
      rows.set(workspace.id, {
        id: workspace.id,
        name: workspace.name,
        role: workspace.role,
        connected: connectedIds.has(workspace.id),
      });
    }
    for (const workspace of selectedBot.workspaces) {
      if (!rows.has(workspace.id)) {
        rows.set(workspace.id, {
          id: workspace.id,
          name: workspace.name,
          role: null,
          connected: true,
        });
      }
    }

    return Array.from(rows.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [selectedBot, workspaces]);

  const replaceBot = (bot: OwnedBot) => {
    setBots((current) => current.map((item) => (item.id === bot.id ? bot : item)));
  };

  const refreshBot = async (botId: string) => {
    if (!token) return;
    const { data, error } = await api.bots({ botId }).get(auth(token));
    if (error) throw new Error(edenErrorMessage(error, "Failed to refresh bot"));
    replaceBot(data as OwnedBot);
  };

  const runAction = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setNotice(null);
    try {
      await action();
    } catch (error) {
      setNotice({
        kind: "error",
        text: error instanceof Error ? error.message : "Something went wrong",
      });
    } finally {
      setBusy(null);
    }
  };

  const saveDetails = () => {
    if (!token || !selectedBot || !name.trim()) return;
    void runAction("save", async () => {
      const { data, error } = await api.bots({ botId: selectedBot.id }).patch(
        {
          name: name.trim(),
          webhookUrl: webhookUrl.trim() || null,
          attachmentAccess,
        },
        auth(token),
      );
      if (error) throw new Error(edenErrorMessage(error, "Failed to update bot"));
      replaceBot(data as OwnedBot);
      setNotice({ kind: "success", text: "Bot details saved." });
    });
  };

  const changeWorkspace = (workspace: WorkspaceRow) => {
    if (!token || !selectedBot) return;
    const actionKey = `workspace:${workspace.id}`;
    void runAction(actionKey, async () => {
      if (workspace.connected) {
        const { error } = await api
          .bots({ botId: selectedBot.id })
          .workspaces({ workspaceId: workspace.id })
          .delete(undefined, auth(token));
        if (error) throw new Error(edenErrorMessage(error, "Failed to disconnect workspace"));
      } else {
        const { error } = await api
          .bots({ botId: selectedBot.id })
          .workspaces.post({ workspaceId: workspace.id }, auth(token));
        if (error) throw new Error(edenErrorMessage(error, "Failed to connect workspace"));
      }

      await refreshBot(selectedBot.id);
      if (activeWorkspace?.id === workspace.id) {
        await selectWorkspace(workspace.id);
      }
      setNotice({
        kind: "success",
        text: workspace.connected
          ? `Disconnected from ${workspace.name}.`
          : `Connected to ${workspace.name}.`,
      });
    });
  };

  const rotateApiKey = () => {
    if (!token || !selectedBot) return;
    const botId = selectedBot.id;
    if (!isConfirming("rotate-key")) {
      setConfirmAction({ botId, action: "rotate-key" });
      return;
    }
    void runAction("rotate-key", async () => {
      const { data, error } = await api
        .bots({ botId })["regenerate-key"]
        .post({}, auth(token));
      if (error) throw new Error(edenErrorMessage(error, "Failed to issue API key"));
      const apiKey = data && "apiKey" in data ? data.apiKey : null;
      if (!apiKey) throw new Error("The API returned no credential");
      setRevealedApiKey({ botId, value: apiKey });
      await refreshBot(botId);
      setConfirmAction((current) =>
        current?.botId === botId && current.action === "rotate-key" ? null : current,
      );
      setNotice({ kind: "success", text: "A new API key was issued." });
    });
  };

  const revokeApiKey = () => {
    if (!token || !selectedBot) return;
    const botId = selectedBot.id;
    if (!isConfirming("revoke-key")) {
      setConfirmAction({ botId, action: "revoke-key" });
      return;
    }
    void runAction("revoke-key", async () => {
      const { error } = await api
        .bots({ botId })["api-key"]
        .delete(undefined, auth(token));
      if (error) throw new Error(edenErrorMessage(error, "Failed to revoke API key"));
      setRevealedApiKey((current) => (current?.botId === botId ? null : current));
      await refreshBot(botId);
      setConfirmAction((current) =>
        current?.botId === botId && current.action === "revoke-key" ? null : current,
      );
      setNotice({ kind: "success", text: "API key revoked." });
    });
  };

  const rotateWebhookSecret = () => {
    if (!token || !selectedBot) return;
    const botId = selectedBot.id;
    if (!isConfirming("rotate-secret")) {
      setConfirmAction({ botId, action: "rotate-secret" });
      return;
    }
    void runAction("rotate-secret", async () => {
      const { data, error } = await api
        .bots({ botId })["regenerate-secret"]
        .post({}, auth(token));
      if (error) throw new Error(edenErrorMessage(error, "Failed to rotate webhook secret"));
      const secret = data && "webhookSecret" in data ? data.webhookSecret : null;
      if (!secret) throw new Error("The API returned no webhook secret");
      setBots((current) =>
        current.map((bot) =>
          bot.id === botId ? { ...bot, webhookSecret: secret } : bot,
        ),
      );
      setShowSecretForBotId(botId);
      setConfirmAction((current) =>
        current?.botId === botId && current.action === "rotate-secret" ? null : current,
      );
      setNotice({ kind: "success", text: "Webhook secret rotated." });
    });
  };

  const deleteBot = () => {
    if (!token || !selectedBot) return;
    const botId = selectedBot.id;
    const botName = selectedBot.name;
    if (!isConfirming("delete")) {
      setConfirmAction({ botId, action: "delete" });
      return;
    }
    void runAction("delete", async () => {
      const { error } = await api.bots({ botId }).delete(undefined, auth(token));
      if (error) throw new Error(edenErrorMessage(error, "Failed to delete bot"));
      const remaining = bots.filter((bot) => bot.id !== botId);
      setBots(remaining);
      setSelectedId((current) => (current === botId ? remaining[0]?.id ?? null : current));
      setConfirmAction((current) => (current?.botId === botId ? null : current));
      setNotice({ kind: "success", text: `${botName} was deleted.` });
      if (activeWorkspace) await selectWorkspace(activeWorkspace.id);
    });
  };

  const copyValue = async (botId: string, label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied({ botId, label });
      window.setTimeout(
        () =>
          setCopied((current) =>
            current?.botId === botId && current.label === label ? null : current,
          ),
        1500,
      );
    } catch {
      setNotice({ kind: "error", text: "Could not copy to the clipboard." });
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-base">
      <div className="mx-auto w-full max-w-[1080px] p-5 lg:p-7">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-[1.5rem] font-semibold tracking-tight text-text">Bots</h1>
            <p className="mt-1 max-w-[620px] text-[0.857rem] leading-relaxed text-text-muted">
              Manage every bot you own, independent of the workspace currently open.
            </p>
          </div>
          <button
            type="button"
            onClick={openHermesBotModal}
            className="cursor-pointer rounded-lg border border-border-strong bg-elevated px-4 py-2 text-[0.857rem] font-semibold text-text transition-colors hover:bg-button"
          >
            Add bot
          </button>
        </div>

        {notice && (
          <div
            role={notice.kind === "error" ? "alert" : "status"}
            className={`mb-4 rounded-lg border px-3.5 py-2.5 text-[0.857rem] ${
              notice.kind === "error"
                ? "border-error-msg-border bg-error-msg-bg text-error-bright"
                : "border-green-500/30 bg-green-500/10 text-green-400"
            }`}
          >
            {notice.text}
          </div>
        )}

        {loading ? (
          <div className="rounded-xl border border-border bg-surface p-8 text-center text-[0.929rem] text-text-muted">
            Loading bots...
          </div>
        ) : bots.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border-strong bg-surface p-10 text-center">
            <div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-elevated text-[1.286rem] text-text">B</div>
            <h2 className="mt-4 text-[1rem] font-semibold text-text">No bots yet</h2>
            <p className="mx-auto mt-1 max-w-[440px] text-[0.857rem] leading-relaxed text-text-muted">
              Create a Hermes bot, then return here to manage its workspaces, credentials, and access.
            </p>
            <button
              type="button"
              onClick={openHermesBotModal}
              className="mt-5 cursor-pointer rounded-lg border border-border-strong bg-elevated px-4 py-2 text-[0.857rem] font-semibold text-text transition-colors hover:bg-button"
            >
              Add bot
            </button>
          </div>
        ) : (
          <div className="grid items-start gap-4 md:grid-cols-[minmax(220px,0.34fr)_minmax(0,1fr)]">
            <aside className="overflow-hidden rounded-xl border border-border bg-surface md:sticky md:top-4">
              <div className="border-b border-border-subtle px-3.5 py-3 text-[0.786rem] font-semibold uppercase tracking-wider text-text-dimmed">
                Your bots · {bots.length}
              </div>
              <div className="max-h-[calc(100vh-220px)] overflow-y-auto p-2">
                {bots.map((bot) => {
                  const selected = bot.id === selectedId;
                  return (
                    <button
                      key={bot.id}
                      type="button"
                      data-testid={`bot-list-item-${bot.id}`}
                      onClick={() => setSelectedId(bot.id)}
                      className={`mb-1 block w-full cursor-pointer rounded-lg border px-3 py-2.5 text-left transition-colors ${
                        selected
                          ? "border-border-strong bg-elevated"
                          : "border-transparent bg-transparent hover:border-border hover:bg-hover"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="min-w-0 truncate text-[0.929rem] font-medium text-text">{bot.name}</span>
                        <span
                          className={`mt-1 size-2 shrink-0 rounded-full ${bot.apiKeyEnabled ? "bg-green-400" : "bg-text-dimmed"}`}
                          title={bot.apiKeyEnabled ? "API key active" : "API key revoked"}
                        />
                      </div>
                      <div className="mt-1.5 flex items-center gap-2 text-[0.714rem] text-text-dimmed">
                        <span>{botKindLabel(bot.kind)}</span>
                        <span>·</span>
                        <span>{bot.workspaces.length} workspace{bot.workspaces.length === 1 ? "" : "s"}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </aside>

            {selectedBot && (
              <main data-testid="bot-management-detail" className="min-w-0 space-y-4">
                <div className="rounded-xl border border-border bg-surface p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="min-w-0 truncate text-[1.214rem] font-semibold text-text">{selectedBot.name}</h2>
                    <BotKindBadge kind={selectedBot.kind} />
                  </div>
                  <div className="mt-1 font-mono text-[0.714rem] text-text-dimmed">{selectedBot.id}</div>
                </div>

                <Section title="Details" description="Rename the bot and control the data it can receive.">
                  <div className="grid gap-4">
                    <label className="grid gap-1.5">
                      <span className="text-[0.786rem] font-medium text-text-muted">Name</span>
                      <input
                        aria-label="Bot name"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        className="rounded-lg border border-border bg-base px-3 py-2 text-[0.929rem] text-text outline-none transition-colors focus:border-border-focus"
                      />
                    </label>
                    <label className="grid gap-1.5">
                      <span className="text-[0.786rem] font-medium text-text-muted">Webhook URL</span>
                      <input
                        aria-label="Webhook URL"
                        value={webhookUrl}
                        onChange={(event) => setWebhookUrl(event.target.value)}
                        placeholder="https://bot.example.com/webhook"
                        className="rounded-lg border border-border bg-base px-3 py-2 text-[0.929rem] text-text outline-none transition-colors placeholder:text-text-placeholder focus:border-border-focus"
                        spellCheck={false}
                      />
                      <span className="text-[0.714rem] text-text-dimmed">Leave blank when the bot uses polling.</span>
                    </label>
                    <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border bg-base px-3 py-3">
                      <input
                        aria-label="Allow message attachments"
                        type="checkbox"
                        checked={attachmentAccess}
                        onChange={(event) => setAttachmentAccess(event.target.checked)}
                        className="mt-0.5 size-4 accent-accent"
                      />
                      <span>
                        <span className="block text-[0.857rem] font-medium text-text-muted">Allow message attachments</span>
                        <span className="mt-0.5 block text-[0.714rem] leading-relaxed text-text-dimmed">
                          The bot may receive, download, and upload attachments in conversations it can access.
                        </span>
                      </span>
                    </label>
                    <div>
                      <button
                        type="button"
                        onClick={saveDetails}
                        disabled={busy !== null || !name.trim()}
                        className="cursor-pointer rounded-lg border border-border-strong bg-elevated px-4 py-2 text-[0.857rem] font-semibold text-text transition-colors hover:not-disabled:bg-button disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {busy === "save" ? "Saving..." : "Save changes"}
                      </button>
                    </div>
                  </div>
                </Section>

                <Section
                  title="Workspaces"
                  description="Connect this bot to workspaces where you are an owner or admin. Disconnecting removes its channel access."
                >
                  {workspaceRows.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border px-4 py-5 text-center text-[0.857rem] text-text-dimmed">
                      You are not a member of any workspaces yet.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {workspaceRows.map((workspace) => {
                        const canConnect = workspace.role === "owner" || workspace.role === "admin";
                        const workspaceBusy = busy === `workspace:${workspace.id}`;
                        return (
                          <div
                            key={workspace.id}
                            data-testid={`bot-workspace-${workspace.id}`}
                            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-base px-3 py-2.5"
                          >
                            <div className="min-w-0">
                              <div className="truncate text-[0.857rem] font-medium text-text">{workspace.name}</div>
                              <div className="mt-0.5 text-[0.714rem] text-text-dimmed">
                                {workspace.connected
                                  ? "Connected"
                                  : canConnect
                                    ? `${workspace.role} access`
                                    : workspace.role
                                      ? "Workspace admin access required"
                                      : "You are no longer a workspace member"}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => changeWorkspace(workspace)}
                              disabled={busy !== null || (!workspace.connected && !canConnect)}
                              className={`cursor-pointer rounded-md border px-3 py-1.5 text-[0.786rem] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                                workspace.connected
                                  ? "border-border bg-raised text-text-muted hover:not-disabled:bg-hover hover:not-disabled:text-text"
                                  : "border-border-strong bg-elevated text-text hover:not-disabled:bg-button"
                              }`}
                            >
                              {workspaceBusy
                                ? workspace.connected ? "Disconnecting..." : "Connecting..."
                                : workspace.connected ? "Disconnect" : "Connect"}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </Section>

                <Section
                  title="Credentials"
                  description="Rotated credentials take effect immediately. API keys are shown only once when issued."
                >
                  {revealedApiKey?.botId === selectedBot.id && (
                    <div className="mb-4 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3">
                      <div className="text-[0.786rem] font-semibold text-amber-300">Copy this API key now</div>
                      <div className="mt-2 flex gap-2">
                        <input
                          aria-label="New API key"
                          readOnly
                          value={revealedApiKey.value}
                          className="min-w-0 flex-1 rounded-md border border-border bg-base px-2.5 py-1.5 font-mono text-[0.714rem] text-text outline-none"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            copyValue(selectedBot.id, "api-key", revealedApiKey.value)
                          }
                          className="cursor-pointer rounded-md border border-border bg-raised px-3 py-1.5 text-[0.786rem] text-text-muted hover:bg-hover hover:text-text"
                        >
                          {copied?.botId === selectedBot.id && copied.label === "api-key"
                            ? "Copied"
                            : "Copy"}
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="space-y-3">
                    <div className="rounded-lg border border-border bg-base p-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="text-[0.857rem] font-medium text-text">Bot API key</div>
                          <div className={`mt-1 text-[0.714rem] ${selectedBot.apiKeyEnabled ? "text-green-400" : "text-text-dimmed"}`}>
                            {selectedBot.apiKeyEnabled ? "Active" : "Revoked"}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={rotateApiKey}
                            disabled={busy !== null}
                            className="cursor-pointer rounded-md border border-border bg-raised px-3 py-1.5 text-[0.786rem] text-text-muted transition-colors hover:not-disabled:bg-hover hover:not-disabled:text-text disabled:opacity-50"
                          >
                            {busy === "rotate-key"
                              ? "Issuing..."
                              : isConfirming("rotate-key")
                                ? "Confirm new key"
                                : selectedBot.apiKeyEnabled ? "Rotate" : "Issue new key"}
                          </button>
                          {selectedBot.apiKeyEnabled && (
                            <button
                              type="button"
                              onClick={revokeApiKey}
                              disabled={busy !== null}
                              className="cursor-pointer rounded-md border border-error-msg-border bg-error-msg-bg px-3 py-1.5 text-[0.786rem] text-error-bright transition-colors hover:not-disabled:brightness-110 disabled:opacity-50"
                            >
                              {busy === "revoke-key"
                                ? "Revoking..."
                                : isConfirming("revoke-key") ? "Confirm revoke" : "Revoke"}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="rounded-lg border border-border bg-base p-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="text-[0.857rem] font-medium text-text">Webhook secret</div>
                          <div className="mt-1 truncate font-mono text-[0.714rem] text-text-dimmed">
                            {showSecretForBotId === selectedBot.id
                              ? selectedBot.webhookSecret
                              : "••••••••••••••••••••••••"}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              setShowSecretForBotId((shownFor) =>
                                shownFor === selectedBot.id ? null : selectedBot.id,
                              )
                            }
                            className="cursor-pointer rounded-md border border-border bg-raised px-3 py-1.5 text-[0.786rem] text-text-muted hover:bg-hover hover:text-text"
                          >
                            {showSecretForBotId === selectedBot.id ? "Hide" : "Reveal"}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              copyValue(
                                selectedBot.id,
                                "webhook-secret",
                                selectedBot.webhookSecret,
                              )
                            }
                            className="cursor-pointer rounded-md border border-border bg-raised px-3 py-1.5 text-[0.786rem] text-text-muted hover:bg-hover hover:text-text"
                          >
                            {copied?.botId === selectedBot.id &&
                            copied.label === "webhook-secret"
                              ? "Copied"
                              : "Copy"}
                          </button>
                          <button
                            type="button"
                            onClick={rotateWebhookSecret}
                            disabled={busy !== null}
                            className="cursor-pointer rounded-md border border-border bg-raised px-3 py-1.5 text-[0.786rem] text-text-muted hover:not-disabled:bg-hover hover:not-disabled:text-text disabled:opacity-50"
                          >
                            {busy === "rotate-secret"
                              ? "Rotating..."
                              : isConfirming("rotate-secret") ? "Confirm rotate" : "Rotate"}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </Section>

                <section className="rounded-xl border border-error-msg-border bg-error-msg-bg/35 p-4">
                  <h3 className="text-[0.929rem] font-semibold text-error-bright">Danger zone</h3>
                  <p className="mt-1 text-[0.786rem] leading-relaxed text-text-muted">
                    Deleting a bot revokes its credentials and removes it from every workspace and conversation.
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={deleteBot}
                      disabled={busy !== null}
                      className="cursor-pointer rounded-lg border border-error-msg-border bg-error-msg-bg px-4 py-2 text-[0.857rem] font-semibold text-error-bright transition-colors hover:not-disabled:brightness-110 disabled:opacity-50"
                    >
                      {busy === "delete"
                        ? "Deleting..."
                        : isConfirming("delete")
                          ? `Confirm delete ${selectedBot.name}`
                          : "Delete bot"}
                    </button>
                    {isConfirming("delete") && (
                      <button
                        type="button"
                        onClick={() => setConfirmAction(null)}
                        className="cursor-pointer border-none bg-transparent text-[0.786rem] text-text-muted hover:text-text"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </section>
              </main>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
