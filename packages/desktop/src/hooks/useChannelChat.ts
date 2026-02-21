import { useState, useCallback, useEffect, useRef } from "react";
import type { ChatMessage } from "@thechat/shared";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3000";

interface UseChannelChatOptions {
  conversationId: string | null;
  token: string | null;
  wsSendMessage: (conversationId: string, content: string) => void;
}

export function useChannelChat({
  conversationId,
  token,
  wsSendMessage,
}: UseChannelChatOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const prevConvId = useRef<string | null>(null);

  // Fetch messages when conversation changes
  useEffect(() => {
    if (!conversationId || !token) {
      setMessages([]);
      prevConvId.current = null;
      return;
    }

    if (conversationId === prevConvId.current) return;
    prevConvId.current = conversationId;

    setLoading(true);
    fetch(`${API_URL}/messages/${conversationId}?limit=50`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setMessages(data);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [conversationId, token]);

  const addMessage = useCallback(
    (msg: ChatMessage) => {
      if (msg.conversationId !== conversationId) return;
      setMessages((prev) => {
        // Deduplicate
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
    },
    [conversationId]
  );

  const sendMessage = useCallback(
    (content: string) => {
      if (!conversationId) return;
      wsSendMessage(conversationId, content);
    },
    [conversationId, wsSendMessage]
  );

  const refetchMessages = useCallback(() => {
    if (!conversationId || !token) return;
    prevConvId.current = null; // Force refetch
    setMessages([]);
  }, [conversationId, token]);

  return { messages, loading, addMessage, sendMessage, refetchMessages };
}
