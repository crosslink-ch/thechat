import { useState, useEffect, useRef } from "react";
import { useParams } from "@tanstack/react-router";
import { useAuthStore } from "../stores/auth";
import { useWebSocketStore } from "../stores/websocket";
import { useConversationsStore } from "../stores/conversations";
import { useChannelChat } from "../hooks/useChannelChat";
import { ChannelChatView } from "../components/ChannelChatView";
import { wsEvents, type WsEvents } from "../lib/ws-events";

export function ChannelRoute() {
  const { id: channelId } = useParams({ from: "/channel/$id" });
  const token = useAuthStore((s) => s.token);
  const wsSendMessage = useWebSocketStore((s) => s.sendMessage);

  const channelChat = useChannelChat({
    conversationId: channelId,
    token,
    wsSendMessage,
  });

  const channelChatRef = useRef(channelChat);
  channelChatRef.current = channelChat;

  const [typingUsers, setTypingUsers] = useState<Map<string, string>>(new Map());
  const typingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

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

    wsEvents.on("ws:new_message", onMessage);
    wsEvents.on("ws:typing", onTyping);

    return () => {
      wsEvents.off("ws:new_message", onMessage);
      wsEvents.off("ws:typing", onTyping);
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

  return (
    <ChannelChatView
      messages={channelChat.messages}
      loading={channelChat.loading}
      typingUsers={typingUsers}
      onSend={channelChat.sendMessage}
    />
  );
}
