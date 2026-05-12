import { useState, useEffect, useRef, useMemo } from "react";
import { useParams } from "@tanstack/react-router";
import type { BotRuntimeSnapshot } from "@thechat/shared";
import { useAuthStore } from "../stores/auth";
import { useWebSocketStore } from "../stores/websocket";
import { useConversationsStore } from "../stores/conversations";
import { useWorkspacesStore } from "../stores/workspaces";
import { useChannelChat } from "../hooks/useChannelChat";
import { ChannelChatView } from "../components/ChannelChatView";
import { HermesRuntimePanel, mergeRuntimeUpdate } from "../components/HermesRuntimePanel";
import { wsEvents, type WsEvents } from "../lib/ws-events";
import { API_URL } from "../lib/api";

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

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
  const [runtime, setRuntime] = useState<BotRuntimeSnapshot | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const hermesBotNames = useMemo(
    () => members?.filter((m) => m.bot?.kind === "hermes").map((m) => m.user.name) ?? [],
    [members],
  );

  // Mark channel as read on mount
  useEffect(() => {
    useConversationsStore.getState().markChannelRead(channelId);
  }, [channelId]);

  useEffect(() => {
    let cancelled = false;
    setRuntime(null);
    if (!token || hermesBotNames.length === 0) return;
    setRuntimeLoading(true);
    fetch(`${API_URL}/bot-runtime/conversations/${channelId}`, { headers: auth(token) })
      .then((response) => {
        if (!response.ok) throw new Error(`Request failed with HTTP ${response.status}`);
        return response.json() as Promise<BotRuntimeSnapshot>;
      })
      .then((snapshot) => {
        if (!cancelled) setRuntime(snapshot);
      })
      .catch(() => {
        if (!cancelled) setRuntime(null);
      })
      .finally(() => {
        if (!cancelled) setRuntimeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, hermesBotNames.length, token]);

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
      setRuntime((prev) => mergeRuntimeUpdate(prev, session, invocation));
    };

    wsEvents.on("ws:new_message", onMessage);
    wsEvents.on("ws:typing", onTyping);
    wsEvents.on("ws:bot_invocation_updated", onBotInvocationUpdated);

    return () => {
      wsEvents.off("ws:new_message", onMessage);
      wsEvents.off("ws:typing", onTyping);
      wsEvents.off("ws:bot_invocation_updated", onBotInvocationUpdated);
      // Clear all typing timers
      for (const timer of typingTimers.current.values()) {
        clearTimeout(timer);
      }
      typingTimers.current.clear();
    };
  }, [channelId]);

  // Clear typing users when channel changes
  useEffect(() => {
    setTypingUsers(new Map());
  }, [channelId]);

  const visibleRuntime = runtime
    ? {
        ...runtime,
        sessions: runtime.sessions.filter((s) => s.botKind === "hermes"),
        invocations: runtime.invocations.filter((i) => i.botKind === "hermes"),
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
