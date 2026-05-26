import { useState, useEffect, useRef, useMemo } from "react";
import { useParams } from "@tanstack/react-router";
import { useAuthStore } from "../stores/auth";
import { useBotRuntime, useBotRuntimeCache } from "../hooks/useBotRuntime";
import { useWebSocketStore } from "../stores/websocket";
import { useConversationsStore } from "../stores/conversations";
import { useWorkspacesStore } from "../stores/workspaces";
import { useChannelChat } from "../hooks/useChannelChat";
import { ChannelChatView } from "../components/ChannelChatView";
import { HermesRuntimePanel } from "../components/HermesRuntimePanel";
import { wsEvents, type WsEvents } from "../lib/ws-events";
import { selectHermesConversationProgress } from "../lib/hermes-progress";

export function ChannelRoute() {
  const { id: channelId } = useParams({ from: "/channel/$id" });
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
    conversationId: channelId,
    token,
    wsSendMessage,
  });

  const channelChatRef = useRef(channelChat);
  channelChatRef.current = channelChat;

  const [typingUsers, setTypingUsers] = useState<Map<string, string>>(new Map());
  const typingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const hermesBotNames = useMemo(
    () => members?.filter((m) => m.bot?.kind === "hermes").map((m) => m.user.name) ?? [],
    [members],
  );
  const runtimeQuery = useBotRuntime(channelId, token, hermesBotNames.length > 0);
  const runtime = runtimeQuery.data ?? null;
  const runtimeLoading = runtimeQuery.isLoading;
  const { mergeInvocationUpdate, mergeProgressEvent } = useBotRuntimeCache();
  const activeHermesProgress = useMemo(
    () => selectHermesConversationProgress(runtime),
    [runtime],
  );

  // Mark channel as read on mount
  useEffect(() => {
    useConversationsStore.getState().markChannelRead(channelId);
  }, [channelId]);

  // Subscribe to WebSocket messages for this channel
  useEffect(() => {
    const onMessage = ({ message: msg }: WsEvents["ws:new_message"]) => {
      if (msg.conversationId === channelId) {
        channelChatRef.current.addMessage(msg);
      }
    };

    const onTyping = ({ conversationId, userId, userName }: WsEvents["ws:typing"]) => {
      if (conversationId !== channelId) return;

      setTypingUsers((prev) => {
        const next = new Map(prev);
        next.set(userId, userName);
        return next;
      });

      // Clear after 3s
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
      conversationId,
      session,
      invocation,
    }: WsEvents["ws:bot_invocation_updated"]) => {
      if (conversationId !== channelId) return;
      mergeInvocationUpdate(channelId, session, invocation);
    };
    const onBotInvocationProgress = ({
      conversationId,
      event,
    }: WsEvents["ws:bot_invocation_progress"]) => {
      if (conversationId !== channelId) return;
      mergeProgressEvent(channelId, event);
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
      // Clear all typing timers
      for (const timer of typingTimers.current.values()) {
        clearTimeout(timer);
      }
      typingTimers.current.clear();
    };
  }, [channelId, mergeInvocationUpdate, mergeProgressEvent]);

  // Clear typing users when channel changes
  useEffect(() => {
    setTypingUsers(new Map());
  }, [channelId]);

  const visibleRuntime = runtime
    ? {
        ...runtime,
        sessions: runtime.sessions.filter((s) => s.botKind === "hermes"),
        invocations: runtime.invocations.filter((i) => i.botKind === "hermes"),
        events: runtime.events.filter((event) =>
          runtime.invocations.some(
            (invocation) =>
              invocation.botKind === "hermes" &&
              invocation.id === event.invocationId,
          ),
        ),
      }
    : null;
  const showHermesPanel = hermesBotNames.length > 0;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <ChannelChatView
          messages={channelChat.messages}
          loading={channelChat.loading}
          typingUsers={typingUsers}
          progressInvocations={activeHermesProgress.invocations}
          progressEvents={activeHermesProgress.events}
          typingSuppressedUserIds={activeHermesProgress.typingSuppressedUserIds}
          onSend={channelChat.sendMessage}
          mentions={mentions}
        />
      </div>
      {showHermesPanel && (
        <HermesRuntimePanel
          title="Hermes Bots"
          botName={hermesBotNames.join(", ")}
          runtime={visibleRuntime}
          loading={runtimeLoading}
        />
      )}
    </div>
  );
}
