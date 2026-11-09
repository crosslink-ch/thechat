import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Webhook, X } from "lucide-react";
import type { WorkspaceChannel } from "@thechat/shared";
import { api, API_URL } from "../lib/api";
import { authHeaders, edenErrorMessage } from "../lib/eden";
import { onSessionReset, sessionGeneration } from "../lib/session-boundary";
import { useAuthStore } from "../stores/auth";
import { useWorkspacesStore } from "../stores/workspaces";
import {
  buttonClass,
  dialogContentClass,
  dialogOverlayClass,
  dialogTitleClass,
  iconButtonClass,
  inputClass,
  labelClass,
  monoInputClass,
} from "./ui";

type WebhookMetadata = {
  id: string;
  name: string;
  tokenStart: string;
  createdAt: string;
  lastUsedAt: string | null;
};
type DialogState = {
  channel: WorkspaceChannel;
  launcher: HTMLElement | null;
  generation: number;
};
let state: DialogState | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => state;
export function openIncomingWebhooksModal(channel: WorkspaceChannel) {
  state = {
    channel,
    launcher:
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null,
    generation: sessionGeneration(),
  };
  listeners.forEach((listener) => listener());
}
export function closeIncomingWebhooksModal() {
  state = null;
  listeners.forEach((listener) => listener());
}
onSessionReset(closeIncomingWebhooksModal);

export function IncomingWebhooksModal() {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.token);
  const workspace = useWorkspacesStore((s) => s.activeWorkspace);
  const role = workspace?.members.find((m) => m.userId === user?.id)?.role;
  const allowed = Boolean(
    current &&
      current.generation === sessionGeneration() &&
      user?.type === "human" &&
      workspace?.id === current.channel.workspaceId &&
      workspace.channels.some((ch) => ch.id === current.channel.id) &&
      (role === "owner" || role === "admin"),
  );
  useEffect(() => {
    if (current && !allowed) closeIncomingWebhooksModal();
  }, [current, allowed]);
  if (!current || !allowed) return null;
  return (
    <WebhookDialog
      key={`${current.channel.id}:${user!.id}:${current.generation}`}
      current={current}
      token={token}
    />
  );
}

function date(value: string | null) {
  return value ? new Date(value).toLocaleString() : "Never";
}
function WebhookDialog({
  current,
  token,
}: {
  current: DialogState;
  token: string | null;
}) {
  const [webhooks, setWebhooks] = useState<WebhookMetadata[]>([]);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ id: string; url: string } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);
  const alive = useRef(true);
  const isCurrent = () =>
    alive.current &&
    state === current &&
    sessionGeneration() === current.generation;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const endpoint = api.channels({ conversationId: current.channel.id })[
    "incoming-webhooks"
  ];
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setLoadFailed(false);
    try {
      const { data, error } = await api
        .channels({ conversationId: current.channel.id })
        ["incoming-webhooks"].get(authHeaders(token));
      if (error)
        throw new Error(edenErrorMessage(error, "Could not load webhooks"));
      if (isCurrent() && data && "webhooks" in data) setWebhooks(data.webhooks);
    } catch (caught) {
      if (isCurrent()) {
        setError(
          caught instanceof Error ? caught.message : "Could not load webhooks",
        );
        setLoadFailed(true);
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [current, token]);
  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy || loading || loadFailed || !name.trim()) return;
    setBusy(true);
    setError("");
    try {
      const { data, error } = await endpoint.post(
        { name: name.trim() },
        authHeaders(token),
      );
      if (error)
        throw new Error(edenErrorMessage(error, "Could not create webhook"));
      if (!data || !("path" in data))
        throw new Error("The API returned no webhook URL");
      if (isCurrent()) {
        setWebhooks((items) => [data.webhook, ...items]);
        setRevealed({
          id: data.webhook.id,
          url: `${API_URL.replace(/\/+$/, "")}${data.path}`,
        });
        setCopied(false);
        setName("");
      }
    } catch (caught) {
      if (isCurrent())
        setError(
          caught instanceof Error ? caught.message : "Could not create webhook",
        );
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }
  async function revoke(id: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const { error } = await endpoint({ webhookId: id }).delete(
        undefined,
        authHeaders(token),
      );
      if (error)
        throw new Error(edenErrorMessage(error, "Could not revoke webhook"));
      if (isCurrent()) {
        setWebhooks((items) => items.filter((item) => item.id !== id));
        setRevealed((value) => (value?.id === id ? null : value));
        setConfirming(null);
      }
    } catch (caught) {
      if (isCurrent())
        setError(
          caught instanceof Error ? caught.message : "Could not revoke webhook",
        );
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }
  async function copy() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.url);
      if (isCurrent()) setCopied(true);
    } catch {
      if (isCurrent())
        setError("Could not copy. Select and copy the URL manually.");
    }
  }
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) closeIncomingWebhooksModal();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={`z-50 ${dialogOverlayClass}`} />
        <Dialog.Content
          className={`fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[600px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-5 ${dialogContentClass}`}
          onEscapeKeyDown={(e) => {
            if (busy) e.preventDefault();
          }}
          onPointerDownOutside={(e) => {
            if (busy) e.preventDefault();
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            if (current.launcher?.isConnected) current.launcher.focus();
          }}
        >
          <div className="flex items-start gap-3">
            <Webhook
              size={20}
              className="mt-1 shrink-0 text-accent"
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <Dialog.Title className={dialogTitleClass}>
                Incoming webhooks
              </Dialog.Title>
              <Dialog.Description className="mt-1 break-words text-[0.857rem] leading-5 text-text-muted">
                Let monitoring tools post to{" "}
                <strong>#{current.channel.name}</strong>. Each secret URL can
                only post to this channel.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                disabled={busy}
                aria-label="Close incoming webhooks"
                className={iconButtonClass()}
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>
          {error && (
            <div
              role="alert"
              className="mt-4 text-[0.857rem] text-error-bright"
            >
              {error}{" "}
              {loadFailed && (
                <button
                  onClick={() => void load()}
                  className={buttonClass("secondary")}
                >
                  Retry
                </button>
              )}
            </div>
          )}
          <form onSubmit={create} className="mt-5">
            <label htmlFor="incoming-webhook-name" className={labelClass}>
              Webhook name
            </label>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                id="incoming-webhook-name"
                className={inputClass}
                placeholder="e.g. Uptime Kuma"
                value={name}
                maxLength={100}
                onChange={(e) => setName(e.target.value)}
                disabled={busy}
                required
              />
              <button
                type="submit"
                className={`${buttonClass("primary")} max-sm:min-h-11`}
                disabled={busy || loading || loadFailed || !name.trim()}
              >
                Create webhook
              </button>
            </div>
            <p className="mt-1.5 text-[0.786rem] text-text-dimmed">
              Messages use this name as their sender.
            </p>
          </form>
          {revealed && (
            <div className="mt-4 rounded-lg border border-border-strong bg-warning-bg p-3">
              <p className="text-[0.857rem] font-medium text-warning-text">
                Copy this URL now. It is shown only once.
              </p>
              <p className="mt-1 text-[0.786rem] text-text-muted">
                Anyone with it can post here. Keep it secret.
              </p>
              <div className="mt-3 flex min-w-0 gap-2">
                <input
                  aria-label="New webhook URL"
                  className={monoInputClass}
                  readOnly
                  value={revealed.url}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button
                  type="button"
                  onClick={() => void copy()}
                  className={`${buttonClass("secondary")} self-center max-sm:min-h-11`}
                >
                  {copied ? "Copied" : "Copy URL"}
                </button>
              </div>
              <button
                type="button"
                onClick={() => setRevealed(null)}
                className={`${buttonClass("ghost", "sm")} mt-2 max-sm:min-h-11`}
              >
                Hide URL
              </button>
            </div>
          )}
          <div className="mt-5 border-t border-border-subtle pt-4">
            <h3 className="mb-2 text-[0.857rem] font-medium text-text-secondary">
              Active webhooks
            </h3>
            {loading ? (
              <p role="status" className="text-text-muted">
                Loading webhooks...
              </p>
            ) : !loadFailed && webhooks.length === 0 ? (
              <p className="text-[0.857rem] text-text-muted">
                No incoming webhooks yet.
              </p>
            ) : (
              <ul
                className="divide-y divide-border-subtle"
                aria-label="Incoming webhooks"
              >
                {webhooks.map((hook) => (
                  <li
                    key={hook.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="break-words text-[0.929rem] font-medium text-text">
                        {hook.name}
                      </div>
                      <code className="text-[0.786rem] text-text-dimmed">
                        {hook.tokenStart}…
                      </code>
                      <div className="mt-1 text-[0.75rem] text-text-muted">
                        Created {date(hook.createdAt)}
                        <br />
                        Last used: {date(hook.lastUsedAt)}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {confirming === hook.id ? (
                        <>
                          <button
                            disabled={busy}
                            onClick={() => setConfirming(null)}
                            className={buttonClass("ghost")}
                          >
                            Cancel
                          </button>
                          <button
                            disabled={busy}
                            onClick={() => void revoke(hook.id)}
                            className={`${buttonClass("danger")} max-sm:min-h-11`}
                          >
                            Confirm revoke
                          </button>
                        </>
                      ) : (
                        <button
                          disabled={busy}
                          onClick={() => setConfirming(hook.id)}
                          aria-label={`Revoke ${hook.name}`}
                          className={`${buttonClass("secondary")} max-sm:min-h-11`}
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="mt-4 border-t border-border-subtle pt-4 text-[0.786rem] leading-5 text-text-dimmed">
            POST JSON with <code>{'{"text":"Your alert"}'}</code>, or choose
            Slack in your monitoring tool. Revoking stops future posts; existing
            messages remain.
          </p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
