import { useState, useCallback, useEffect, useRef } from "react";
import type { ChatMessage } from "@thechat/shared";
import { api } from "../lib/api";

const MESSAGE_CACHE_TTL_MS = 60_000;

interface MessageCacheEntry {
  messages: ChatMessage[];
  loadedAt: number;
}

const messageCache = new Map<string, MessageCacheEntry>();

interface UseChannelChatOptions {
  conversationId: string | null;
  token: string | null;
  botSessionId?: string | null;
  wsSendMessage: (conversationId: string, content: string, botSessionId?: string | null) => void;
}

export function clearChannelChatCache() {
  messageCache.clear();
}

export const clearChannelChatCacheForTests = clearChannelChatCache;

export function useChannelChat({
  conversationId,
  token,
  botSessionId,
  wsSendMessage,
}: UseChannelChatOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const requestSeq = useRef(0);

  // Fetch messages when conversation changes
  useEffect(() => {
    if (!conversationId || !token) {
      requestSeq.current += 1;
      setMessages([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const requestId = requestSeq.current + 1;
    requestSeq.current = requestId;
    const key = cacheKey(conversationId, botSessionId);
    const cached = messageCache.get(key);
    if (cached) {
      setMessages(cached.messages);
      setLoading(false);
      if (reloadKey === 0 && Date.now() - cached.loadedAt < MESSAGE_CACHE_TTL_MS) {
        return () => {
          cancelled = true;
        };
      }
    } else {
      setMessages([]);
      setLoading(true);
    }

    api.messages({ conversationId }).get({
      query: { limit: 50, botSessionId: botSessionId ?? undefined },
      headers: { authorization: `Bearer ${token}` },
    })
      .then(({ data }) => {
        if (cancelled || requestId !== requestSeq.current) return;
        if (Array.isArray(data)) {
          const nextMessages = data as ChatMessage[];
          messageCache.set(key, { messages: nextMessages, loadedAt: Date.now() });
          setMessages(nextMessages);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled && requestId === requestSeq.current) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [botSessionId, conversationId, token, reloadKey]);

  const addMessage = useCallback(
    (msg: ChatMessage) => {
      if (msg.conversationId !== conversationId) return;
      if (botSessionId !== undefined && msg.botSessionId !== botSessionId) return;
      setMessages((prev) => {
        // Deduplicate
        if (prev.some((m) => m.id === msg.id)) return prev;
        const next = [...prev, msg];
        messageCache.set(cacheKey(conversationId, botSessionId), {
          messages: next,
          loadedAt: Date.now(),
        });
        return next;
      });
    },
    [botSessionId, conversationId]
  );

  const sendMessage = useCallback(
    (content: string) => {
      if (!conversationId) return;
      wsSendMessage(conversationId, content, botSessionId);
    },
    [botSessionId, conversationId, wsSendMessage]
  );

  const refetchMessages = useCallback(() => {
    if (!conversationId || !token) return;
    setReloadKey((key) => key + 1);
  }, [conversationId, token]);

  return { messages, loading, addMessage, sendMessage, refetchMessages };
}

function cacheKey(conversationId: string, botSessionId: string | null | undefined) {
  return `${conversationId}:${botSessionId ?? "all"}`;
}
