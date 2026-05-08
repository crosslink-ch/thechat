import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useParams } from "@tanstack/react-router";
import type {
  BotEventPublic,
  BotInvocationPublic,
  BotRuntimeSnapshot,
  BotSessionPublic,
  ConversationDetail,
} from "@thechat/shared";
import { useAuthStore } from "../stores/auth";
import { useWebSocketStore } from "../stores/websocket";
import { useWorkspacesStore } from "../stores/workspaces";
import { useChannelChat } from "../hooks/useChannelChat";
import { ChannelChatView } from "../components/ChannelChatView";
import { fireNotification } from "../lib/notifications";
import { wsEvents, type WsEvents } from "../lib/ws-events";
import { API_URL } from "../lib/api";

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

export function DmRoute() {
  const { id: conversationId } = useParams({ from: "/dm/$id" });
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const members = useWorkspacesStore((s) => s.activeWorkspace?.members);
  const wsSendMessage = useWebSocketStore((s) => s.sendMessage);

  const mentions = useMemo(
    () =>
      members
        ?.filter((m) => m.userId !== user?.id)
        .map((m) => ({ id: m.userId, label: m.user.name, type: m.user.type })),
    [members, user?.id]
  );

  const channelChat = useChannelChat({
    conversationId,
    token,
    wsSendMessage,
  });

  const channelChatRef = useRef(channelChat);
  channelChatRef.current = channelChat;

  const [typingUsers, setTypingUsers] = useState<Map<string, string>>(new Map());
  const typingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [conversation, setConversation] = useState<ConversationDetail | null>(null);
  const [runtime, setRuntime] = useState<BotRuntimeSnapshot | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(false);

  const otherParticipant = useMemo(
    () => conversation?.participants.find((p) => p.userId !== user?.id) ?? null,
    [conversation, user?.id],
  );
  const isHermesDm = conversation?.type === "direct" && otherParticipant?.bot?.kind === "hermes";

  const fetchRuntime = useCallback(async () => {
    if (!token) return;
    setRuntimeLoading(true);
    try {
      const snapshot = await fetchJson<BotRuntimeSnapshot>(
        `/bot-runtime/conversations/${conversationId}`,
        token,
      );
      setRuntime(snapshot);
    } catch {
      setRuntime(null);
    } finally {
      setRuntimeLoading(false);
    }
  }, [conversationId, token]);

  useEffect(() => {
    let cancelled = false;
    setConversation(null);
    setRuntime(null);
    if (!token) return;

    fetchJson<ConversationDetail>(`/conversations/detail/${conversationId}`, token)
      .then((detail) => {
        if (!cancelled) setConversation(detail);
      })
      .catch(() => {
        if (!cancelled) setConversation(null);
      });

    return () => {
      cancelled = true;
    };
  }, [conversationId, token]);

  useEffect(() => {
    if (!isHermesDm) return;
    void fetchRuntime();
  }, [fetchRuntime, isHermesDm]);

  // Subscribe to WebSocket messages for this DM
  useEffect(() => {
    const onMessage = ({
      message: msg,
      conversationType,
    }: WsEvents["ws:new_message"]) => {
      if (msg.conversationId === conversationId) {
        channelChatRef.current.addMessage(msg);
        // Clear typing indicator for this user
        setTypingUsers((prev) => {
          if (!prev.has(msg.senderId)) return prev;
          const next = new Map(prev);
          next.delete(msg.senderId);
          return next;
        });
      } else if (conversationType === "direct" && msg.senderId !== user?.id) {
        fireNotification(msg.senderName, msg.content);
      }
    };

    const onTyping = ({
      conversationId: convId,
      userId,
      userName,
    }: WsEvents["ws:typing"]) => {
      if (convId !== conversationId) return;

      setTypingUsers((prev) => {
        const next = new Map(prev);
        next.set(userId, userName);
        return next;
      });

      const existing = typingTimers.current.get(userId);
      if (existing) clearTimeout(existing);
      typingTimers.current.set(
        userId,
        setTimeout(() => {
          setTypingUsers((prev) => {
            const next = new Map(prev);
            next.delete(userId);
            return next;
          });
          typingTimers.current.delete(userId);
        }, 3000),
      );
    };

    const onBotInvocationUpdated = ({
      conversationId: convId,
      session,
      invocation,
      event,
    }: WsEvents["ws:bot_invocation_updated"]) => {
      if (convId !== conversationId) return;
      setRuntime((prev) => mergeRuntimeUpdate(prev, session, invocation, event));
    };

    wsEvents.on("ws:new_message", onMessage);
    wsEvents.on("ws:typing", onTyping);
    wsEvents.on("ws:bot_invocation_updated", onBotInvocationUpdated);

    return () => {
      wsEvents.off("ws:new_message", onMessage);
      wsEvents.off("ws:typing", onTyping);
      wsEvents.off("ws:bot_invocation_updated", onBotInvocationUpdated);
      for (const timer of typingTimers.current.values()) {
        clearTimeout(timer);
      }
      typingTimers.current.clear();
    };
  }, [conversationId, user?.id]);

  // Clear typing users when DM changes
  useEffect(() => {
    setTypingUsers(new Map());
  }, [conversationId]);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <ChannelChatView
          messages={channelChat.messages}
          loading={channelChat.loading}
          typingUsers={typingUsers}
          onSend={channelChat.sendMessage}
          mentions={mentions}
        />
      </div>
      {isHermesDm && (
        <HermesDmPanel
          botName={otherParticipant.user.name}
          runtime={runtime}
          loading={runtimeLoading}
        />
      )}
    </div>
  );
}

async function fetchJson<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    headers: auth(token),
  });
  if (!response.ok) {
    throw new Error(`Request failed with HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function mergeRuntimeUpdate(
  prev: BotRuntimeSnapshot | null,
  session: BotSessionPublic | null,
  invocation: BotInvocationPublic,
  event: BotEventPublic | null,
): BotRuntimeSnapshot {
  const snapshot = prev ?? { sessions: [], invocations: [], events: [] };
  return {
    sessions: session ? upsertById(snapshot.sessions, session) : snapshot.sessions,
    invocations: upsertById(snapshot.invocations, invocation),
    events: event ? upsertById(snapshot.events, event) : snapshot.events,
  };
}

function upsertById<T extends { id: string }>(items: T[], item: T) {
  const next = items.filter((existing) => existing.id !== item.id);
  next.unshift(item);
  return next;
}

function HermesDmPanel({
  botName,
  runtime,
  loading,
}: {
  botName: string;
  runtime: BotRuntimeSnapshot | null;
  loading: boolean;
}) {
  const sessions = runtime?.sessions ?? [];
  const invocations = runtime?.invocations ?? [];

  return (
    <aside className="hidden w-80 shrink-0 flex-col border-l border-border bg-surface/70 lg:flex">
      <div className="border-b border-border px-4 py-3">
        <div className="text-[0.786rem] font-medium uppercase text-text-dimmed">Hermes</div>
        <div className="truncate text-[1rem] font-semibold text-text">{botName}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <section className="mb-5">
          <div className="mb-2 text-[0.786rem] font-medium uppercase text-text-dimmed">Sessions</div>
          {loading && sessions.length === 0 ? (
            <div className="text-[0.857rem] text-text-placeholder">Loading...</div>
          ) : sessions.length === 0 ? (
            <div className="text-[0.857rem] text-text-placeholder">No sessions yet</div>
          ) : (
            <div className="space-y-2">
              {sessions.map((session) => (
                <div key={session.id} className="rounded-md border border-border bg-background px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[0.857rem] font-medium text-text">
                      {session.title || "Direct message"}
                    </span>
                    <StatusPill status={session.status} />
                  </div>
                  <div className="mt-1 truncate text-[0.714rem] text-text-dimmed">
                    {session.externalSessionId ?? session.id}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <div className="mb-2 text-[0.786rem] font-medium uppercase text-text-dimmed">Activity</div>
          {loading && invocations.length === 0 ? (
            <div className="text-[0.857rem] text-text-placeholder">Loading...</div>
          ) : invocations.length === 0 ? (
            <div className="text-[0.857rem] text-text-placeholder">No activity yet</div>
          ) : (
            <div className="space-y-2">
              {invocations.map((invocation) => (
                <InvocationRow key={invocation.id} invocation={invocation} />
              ))}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}

function InvocationRow({ invocation }: { invocation: BotInvocationPublic }) {
  const partial = typeof invocation.responseJson?.partialOutput === "string"
    ? invocation.responseJson.partialOutput
    : "";
  const output = typeof invocation.responseJson?.output === "string"
    ? invocation.responseJson.output
    : partial;

  return (
    <div className="rounded-md border border-border bg-background px-3 py-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[0.857rem] font-medium text-text">{formatInvocationTime(invocation.createdAt)}</span>
        <StatusPill status={invocation.status} />
      </div>
      {invocation.externalRunId && (
        <div className="truncate text-[0.714rem] text-text-dimmed">{invocation.externalRunId}</div>
      )}
      {output && (
        <div className="mt-2 line-clamp-3 text-[0.786rem] leading-5 text-text-muted">{output}</div>
      )}
      {invocation.error && (
        <div className="mt-2 line-clamp-3 text-[0.786rem] leading-5 text-error-bright">{invocation.error}</div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "completed"
      ? "border-success-border bg-success-bg text-success"
      : status === "failed"
        ? "border-error-border bg-error-bg text-error-bright"
        : status === "running"
          ? "border-accent/40 bg-accent/10 text-accent"
          : "border-border bg-raised text-text-muted";
  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[0.643rem] font-medium uppercase ${tone}`}>
      {status}
    </span>
  );
}

function formatInvocationTime(iso: string) {
  const date = new Date(iso);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
