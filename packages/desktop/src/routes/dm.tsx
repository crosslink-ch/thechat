import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useParams } from "@tanstack/react-router";
import type {
  BotRuntimeSnapshot,
  ConversationDetail,
} from "@thechat/shared";
import { useAuthStore } from "../stores/auth";
import { useWebSocketStore } from "../stores/websocket";
import { useWorkspacesStore } from "../stores/workspaces";
import { useChannelChat } from "../hooks/useChannelChat";
import { useScopedCommands } from "../hooks/useScopedCommands";
import { ChannelChatView } from "../components/ChannelChatView";
import {
  HermesRuntimePanel,
  mergeRuntimeProgressEvent,
  mergeRuntimeUpdate,
} from "../components/HermesRuntimePanel";
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

  const [typingUsers, setTypingUsers] = useState<Map<string, string>>(new Map());
  const typingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [conversation, setConversation] = useState<ConversationDetail | null>(null);
  const [runtime, setRuntime] = useState<BotRuntimeSnapshot | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [activeBotSessionId, setActiveBotSessionId] = useState<string | null>(null);

  const otherParticipant = useMemo(
    () => conversation?.participants.find((p) => p.userId !== user?.id) ?? null,
    [conversation, user?.id],
  );
  const isHermesDm = conversation?.type === "direct" && otherParticipant?.bot?.kind === "hermes";
  const hermesSessions = useMemo(
    () => runtime?.sessions.filter((session) => session.botKind === "hermes") ?? [],
    [runtime],
  );
  const activeHermesProgress = useMemo(() => {
    const invocations = (runtime?.invocations ?? []).filter(
      (invocation) =>
        invocation.botKind === "hermes" &&
        (invocation.status === "queued" || invocation.status === "running"),
    );
    const invocationIds = new Set(invocations.map((invocation) => invocation.id));
    return {
      invocations,
      events: (runtime?.events ?? []).filter((event) => invocationIds.has(event.invocationId)),
    };
  }, [runtime]);

  const channelChat = useChannelChat({
    conversationId,
    token,
    botSessionId: isHermesDm ? activeBotSessionId ?? undefined : undefined,
    wsSendMessage,
  });

  const channelChatRef = useRef(channelChat);
  channelChatRef.current = channelChat;

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

  useEffect(() => {
    if (!isHermesDm) {
      setActiveBotSessionId(null);
      return;
    }
    if (activeBotSessionId && hermesSessions.some((session) => session.id === activeBotSessionId)) {
      return;
    }
    setActiveBotSessionId(hermesSessions[0]?.id ?? null);
  }, [activeBotSessionId, hermesSessions, isHermesDm]);

  const handleCreateSession = useCallback(async () => {
    if (!token || !isHermesDm || creatingSession) return;
    setCreatingSession(true);
    try {
      const session = await postJson<BotRuntimeSnapshot["sessions"][number]>(
        `/bot-runtime/conversations/${conversationId}/sessions`,
        token,
        {},
      );
      setRuntime((prev) => ({
        sessions: [session, ...(prev?.sessions ?? []).filter((existing) => existing.id !== session.id)],
        invocations: prev?.invocations ?? [],
        events: prev?.events ?? [],
      }));
      setActiveBotSessionId(session.id);
    } finally {
      setCreatingSession(false);
    }
  }, [conversationId, creatingSession, isHermesDm, token]);

  const hermesSessionCommands = useMemo(
    () =>
      isHermesDm
        ? [
            {
              id: "hermes.new-session",
              label: "New Hermes Session",
              shortcut: "C-x n",
              keybinding: { prefix: "C-x", key: "n" },
              priority: 50,
              execute: handleCreateSession,
            },
          ]
        : [],
    [handleCreateSession, isHermesDm],
  );
  useScopedCommands(hermesSessionCommands);

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
    }: WsEvents["ws:bot_invocation_updated"]) => {
      if (convId !== conversationId) return;
      setRuntime((prev) => mergeRuntimeUpdate(prev, session, invocation));
    };
    const onBotInvocationProgress = ({
      conversationId: convId,
      event,
    }: WsEvents["ws:bot_invocation_progress"]) => {
      if (convId !== conversationId) return;
      setRuntime((prev) => mergeRuntimeProgressEvent(prev, event));
    };

    wsEvents.on("ws:new_message", onMessage);
    wsEvents.on("ws:typing", onTyping);
    wsEvents.on("ws:bot_invocation_updated", onBotInvocationUpdated);
    wsEvents.on("ws:bot_invocation_progress", onBotInvocationProgress);

    return () => {
      wsEvents.off("ws:new_message", onMessage);
      wsEvents.off("ws:typing", onTyping);
      wsEvents.off("ws:bot_invocation_updated", onBotInvocationUpdated);
      wsEvents.off("ws:bot_invocation_progress", onBotInvocationProgress);
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
          progressInvocations={activeHermesProgress.invocations}
          progressEvents={activeHermesProgress.events}
          onSend={channelChat.sendMessage}
          mentions={mentions}
        />
      </div>
      {isHermesDm && (
        <HermesRuntimePanel
          botName={otherParticipant.user.name}
          runtime={runtime}
          loading={runtimeLoading}
          activeSessionId={activeBotSessionId}
          creatingSession={creatingSession}
          onCreateSession={handleCreateSession}
          onSelectSession={setActiveBotSessionId}
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

async function postJson<T>(path: string, token: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: {
      ...auth(token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Request failed with HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}
