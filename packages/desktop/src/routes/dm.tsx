import { useState, useEffect, useRef } from "react";
import { useParams } from "@tanstack/react-router";
import { useAuthStore } from "../stores/auth";
import { useWebSocketStore } from "../stores/websocket";
import { useChannelChat } from "../hooks/useChannelChat";
import { ChannelChatView } from "../components/ChannelChatView";
import { fireNotification } from "../lib/notifications";

export function DmRoute() {
  const { id: conversationId } = useParams({ from: "/dm/$id" });
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const wsSendMessage = useWebSocketStore((s) => s.sendMessage);

  const channelChat = useChannelChat({
    conversationId,
    token,
    wsSendMessage,
  });

  const channelChatRef = useRef(channelChat);
  channelChatRef.current = channelChat;

  const [typingUsers, setTypingUsers] = useState<Map<string, string>>(new Map());
  const typingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Subscribe to WebSocket messages for this DM
  useEffect(() => {
    const unsubMessages = useWebSocketStore.getState().subscribeToMessages(
      (msg, conversationType) => {
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
      },
    );

    const unsubTyping = useWebSocketStore.getState().subscribeToTyping(
      (convId, userId, userName) => {
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
      },
    );

    return () => {
      unsubMessages();
      unsubTyping();
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
    <ChannelChatView
      messages={channelChat.messages}
      loading={channelChat.loading}
      typingUsers={typingUsers}
      onSend={channelChat.sendMessage}
    />
  );
}
