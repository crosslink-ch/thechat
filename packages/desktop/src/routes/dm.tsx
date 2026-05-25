import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useParams } from "@tanstack/react-router";
import type { BotRuntimeSnapshot } from "@thechat/shared";
import { useAuthStore } from "../stores/auth";
import { useBotRuntimeStore } from "../stores/bot-runtime";
import { useConversationDetailsStore } from "../stores/conversation-details";
import { useWebSocketStore } from "../stores/websocket";
import { useWorkspacesStore } from "../stores/workspaces";
import { useChannelChat } from "../hooks/useChannelChat";
import { useScopedCommands } from "../hooks/useScopedCommands";
import { ChannelChatView } from "../components/ChannelChatView";
import { HermesRuntimePanel } from "../components/HermesRuntimePanel";
import { fireNotification } from "../lib/notifications";
import { wsEvents, type WsEvents } from "../lib/ws-events";
import { API_URL } from "../lib/api";
import { selectHermesSessionProgress } from "../lib/hermes-progress";

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

export function DmRoute() {
  const { id: conversationId } = useParams({ from: "/dm/$id" });
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const members = useWorkspacesStore((s) => s.activeWorkspace?.members);
  const wsSendMessage = useWebSocketStore((s) => s.sendMessage);
  const conversationEntry = useConversationDetailsStore((s) => s.entries[conversationId]);
  const conversationLoading = conversationEntry?.loading ?? false;
  const conversation = conversationEntry?.detail ?? null;
  const conversationPending = !conversation && !!token && !conversationEntry?.error;
  const fetchConversationDetail = useConversationDetailsStore((s) => s.fetchDetail);
  const runtimeEntry = useBotRuntimeStore((s) => s.entries[conversationId]);
  const runtime = runtimeEntry?.runtime ?? null;
  const runtimeLoading = runtimeEntry?.loading ?? false;
  const activeBotSessionId = useBotRuntimeStore(
    (s) => s.activeSessionIds[conversationId] ?? null,
  );
  const fetchRuntime = useBotRuntimeStore((s) => s.fetchRuntime);
  const updateRuntime = useBotRuntimeStore((s) => s.updateRuntime);
  const mergeInvocationUpdate = useBotRuntimeStore((s) => s.mergeInvocationUpdate);
  const mergeProgressEvent = useBotRuntimeStore((s) => s.mergeProgressEvent);
  const setStoredActiveSessionId = useBotRuntimeStore((s) => s.setActiveSessionId);

  const mentions = useMemo(
    () =>
      members
        ?.filter((m) => m.userId !== user?.id)
        .map((m) => ({ id: m.userId, label: m.user.name, type: m.user.type })),
    [members, user?.id]
  );

  const [typingUsers, setTypingUsers] = useState<Map<string, string>>(new Map());
  const typingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [creatingSession, setCreatingSession] = useState(false);

  const otherParticipant = useMemo(
    () => conversation?.participants.find((p) => p.userId !== user?.id) ?? null,
    [conversation, user?.id],
  );
  const isHermesDm = conversation?.type === "direct" && otherParticipant?.bot?.kind === "hermes";
  const hermesSessions = useMemo(
    () => runtime?.sessions.filter((session) => session.botKind === "hermes") ?? [],
    [runtime],
  );
  const effectiveHermesSessionId =
    activeBotSessionId ?? hermesSessions[0]?.id ?? null;
  const activeHermesProgress = useMemo(
    () => selectHermesSessionProgress(runtime, effectiveHermesSessionId),
    [effectiveHermesSessionId, runtime],
  );
  const waitingForHermesRuntime =
    !!conversation && isHermesDm && runtimeLoading && !runtime && !effectiveHermesSessionId;
  const chatConversationId =
    conversation && !waitingForHermesRuntime ? conversationId : null;

  const channelChat = useChannelChat({
    conversationId: chatConversationId,
    token,
    botSessionId: isHermesDm ? effectiveHermesSessionId ?? undefined : undefined,
    wsSendMessage,
  });

  const channelChatRef = useRef(channelChat);
  channelChatRef.current = channelChat;

  useEffect(() => {
    if (!token) return;
    void fetchConversationDetail(conversationId, token);
  }, [conversationId, fetchConversationDetail, token]);

  useEffect(() => {
    if (!isHermesDm || !token) return;
    void fetchRuntime(conversationId, token);
  }, [conversationId, fetchRuntime, isHermesDm, token]);

  useEffect(() => {
    if (!isHermesDm) return;
    if (activeBotSessionId && hermesSessions.some((session) => session.id === activeBotSessionId)) {
      return;
    }
    setStoredActiveSessionId(conversationId, hermesSessions[0]?.id ?? null);
  }, [
    activeBotSessionId,
    conversationId,
    hermesSessions,
    isHermesDm,
    setStoredActiveSessionId,
  ]);

  const handleCreateSession = useCallback(async () => {
    if (!token || !isHermesDm || creatingSession) return;
    setCreatingSession(true);
    try {
      const session = await postJson<BotRuntimeSnapshot["sessions"][number]>(
        `/bot-runtime/conversations/${conversationId}/sessions`,
        token,
        {},
      );
      updateRuntime(conversationId, (prev) => ({
        sessions: [session, ...(prev?.sessions ?? []).filter((existing) => existing.id !== session.id)],
        invocations: prev?.invocations ?? [],
        events: prev?.events ?? [],
      }));
      setStoredActiveSessionId(conversationId, session.id);
    } finally {
      setCreatingSession(false);
    }
  }, [
    conversationId,
    creatingSession,
    isHermesDm,
    setStoredActiveSessionId,
    token,
    updateRuntime,
  ]);

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
      botSessionId,
    }: WsEvents["ws:typing"]) => {
      if (convId !== conversationId) return;
      if (isHermesDm && botSessionId && botSessionId !== effectiveHermesSessionId) return;

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
      mergeInvocationUpdate(conversationId, session, invocation);
    };
    const onBotInvocationProgress = ({
      conversationId: convId,
      event,
    }: WsEvents["ws:bot_invocation_progress"]) => {
      if (convId !== conversationId) return;
      mergeProgressEvent(conversationId, event);
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
  }, [
    conversationId,
    effectiveHermesSessionId,
    isHermesDm,
    mergeInvocationUpdate,
    mergeProgressEvent,
    user?.id,
  ]);

  // Clear typing users when the visible DM session changes.
  useEffect(() => {
    setTypingUsers(new Map());
  }, [conversationId, effectiveHermesSessionId]);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <ChannelChatView
          messages={channelChat.messages}
          loading={
            channelChat.loading ||
            conversationLoading ||
            conversationPending ||
            waitingForHermesRuntime
          }
          typingUsers={typingUsers}
          progressInvocations={activeHermesProgress.invocations}
          progressEvents={activeHermesProgress.events}
          typingSuppressedUserIds={activeHermesProgress.typingSuppressedUserIds}
          onSend={channelChat.sendMessage}
          mentions={mentions}
        />
      </div>
      {isHermesDm && (
        <HermesRuntimePanel
          botName={otherParticipant.user.name}
          runtime={runtime}
          loading={runtimeLoading}
          activeSessionId={effectiveHermesSessionId}
          creatingSession={creatingSession}
          onCreateSession={handleCreateSession}
          onSelectSession={(sessionId) => setStoredActiveSessionId(conversationId, sessionId)}
        />
      )}
    </div>
  );
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
