import { useCallback } from "react";
import {
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import type { ChatMessage } from "@thechat/shared";
import { api } from "../lib/api";
import { authHeaders, edenErrorMessage } from "../lib/eden";

const MESSAGE_CACHE_TTL_MS = 60_000;
export const MESSAGE_PAGE_SIZE = 20;
export const MESSAGE_WINDOW_SIZE = 120;

interface UseChannelChatOptions {
  conversationId: string | null;
  threadId?: string | null;
  unthreadedOnly?: boolean;
  token: string | null;
  wsSendMessage: (conversationId: string, content: string, threadId?: string | null) => void;
}

export const messagesQueryKey = (
  conversationId: string,
  threadId?: string | null,
  unthreadedOnly = false,
) => ["messages", conversationId, unthreadedOnly ? "general" : threadId ?? "all"] as const;

interface MessagePage {
  messages: ChatMessage[];
  hasOlder: boolean;
}

type MessageWindow = InfiniteData<MessagePage, string | null>;

async function fetchMessages(
  conversationId: string,
  token: string,
  threadId?: string | null,
  unthreadedOnly = false,
  before?: string | null,
): Promise<ChatMessage[]> {
  const query: Record<string, string | number> = { limit: MESSAGE_PAGE_SIZE };
  if (before) {
    query.before = before;
  }
  if (threadId) {
    query.threadId = threadId;
  } else if (unthreadedOnly) {
    query.unthreaded = "true";
  }

  const { data, error } = await api.messages({ conversationId }).get({
    query,
    ...authHeaders(token),
  });

  if (error) {
    throw new Error(edenErrorMessage(error, "Failed to load messages"));
  }

  return Array.isArray(data) ? (data as ChatMessage[]) : [];
}

async function fetchMessagePage(
  conversationId: string,
  token: string,
  threadId: string | null,
  unthreadedOnly: boolean,
  before: string | null,
): Promise<MessagePage> {
  const messages = await fetchMessages(
    conversationId,
    token,
    threadId,
    unthreadedOnly,
    before,
  );
  return {
    messages,
    hasOlder: messages.length === MESSAGE_PAGE_SIZE,
  };
}

export function useChannelChat({
  conversationId,
  threadId = null,
  unthreadedOnly = false,
  token,
  wsSendMessage,
}: UseChannelChatOptions) {
  const queryClient = useQueryClient();
  const query = useInfiniteQuery<
    MessagePage,
    Error,
    MessageWindow,
    readonly unknown[],
    string | null
  >({
    queryKey: conversationId
      ? messagesQueryKey(conversationId, threadId, unthreadedOnly)
      : ["messages", "disabled"],
    queryFn: ({ pageParam }) =>
      fetchMessagePage(
        conversationId!,
        token!,
        threadId,
        unthreadedOnly,
        pageParam,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.hasOlder ? oldestMessageCursor(lastPage.messages) : undefined,
    enabled: !!conversationId && !!token,
    staleTime: MESSAGE_CACHE_TTL_MS,
  });

  const addMessage = useCallback(
    (msg: ChatMessage) => {
      if (msg.conversationId !== conversationId) return;

      const updateCache = (
        cacheThreadId: string | null,
        cacheUnthreadedOnly: boolean,
        createIfMissing: boolean,
      ) => {
        const key = messagesQueryKey(conversationId, cacheThreadId, cacheUnthreadedOnly);
        if (!createIfMissing && queryClient.getQueryData(key) === undefined) return;
        queryClient.setQueryData<MessageWindow>(key, (prev) =>
          appendMessageToWindow(prev, msg),
        );
      };

      if (msg.threadId) {
        updateCache(msg.threadId, false, !unthreadedOnly && msg.threadId === threadId);
        updateCache(null, false, !unthreadedOnly && threadId === null);
      } else {
        updateCache(null, true, unthreadedOnly && threadId === null);
        updateCache(null, false, !unthreadedOnly && threadId === null);
      }
    },
    [conversationId, queryClient, threadId, unthreadedOnly],
  );

  const sendMessage = useCallback(
    (content: string) => {
      if (!conversationId) return;
      wsSendMessage(conversationId, content, threadId ?? null);
    },
    [conversationId, threadId, wsSendMessage],
  );

  const refetchMessages = useCallback(() => {
    if (!conversationId || !token) return;
    void query.refetch();
  }, [conversationId, query.refetch, token]);

  const loadOlderMessages = useCallback(async () => {
    if (!conversationId || !token || !query.hasNextPage || query.isFetchingNextPage) {
      return false;
    }
    const result = await query.fetchNextPage();
    const pages = result.data?.pages ?? [];
    const loadedPage = pages[pages.length - 1];
    return (loadedPage?.messages.length ?? 0) > 0;
  }, [
    conversationId,
    query.fetchNextPage,
    query.hasNextPage,
    query.isFetchingNextPage,
    token,
  ]);

  const trimToRecentMessages = useCallback(() => {
    if (!conversationId) return;
    const key = messagesQueryKey(conversationId, threadId, unthreadedOnly);
    queryClient.setQueryData<MessageWindow>(key, (prev) =>
      trimWindowToRecentMessages(prev),
    );
  }, [conversationId, queryClient, threadId, unthreadedOnly]);

  return {
    messages: flattenMessageWindow(query.data),
    loading: query.isLoading,
    loadingOlder: query.isFetchingNextPage,
    hasOlderMessages: query.hasNextPage,
    addMessage,
    sendMessage,
    refetchMessages,
    loadOlderMessages,
    trimToRecentMessages,
  };
}

function appendMessage(messages: ChatMessage[], msg: ChatMessage) {
  if (messages.some((m) => m.id === msg.id)) return messages;
  return [...messages, msg];
}

function appendMessageToWindow(
  window: MessageWindow | undefined,
  msg: ChatMessage,
): MessageWindow {
  if (!window) {
    return {
      pages: [{ messages: [msg], hasOlder: false }],
      pageParams: [null],
    };
  }
  if (window.pages.some((page) => page.messages.some((m) => m.id === msg.id))) {
    return window;
  }

  const pages = window.pages.map((page) => ({
    ...page,
    messages: [...page.messages],
  }));
  if (pages.length === 0) {
    pages.push({ messages: [], hasOlder: false });
  }
  pages[0].messages = appendMessage(pages[0].messages, msg);
  return { ...window, pages };
}

function trimWindowToRecentMessages(
  window: MessageWindow | undefined,
): MessageWindow | undefined {
  if (!window) return window;
  const messages = flattenMessageWindow(window);
  if (messages.length <= MESSAGE_WINDOW_SIZE) return window;

  const recentMessages = messages.slice(-MESSAGE_WINDOW_SIZE);
  const pages = buildNewestFirstPages(recentMessages, true);
  return {
    pages,
    pageParams: buildPageParams(pages),
  };
}

function flattenMessageWindow(window: MessageWindow | undefined): ChatMessage[] {
  if (!window) return [];
  const seen = new Set<string>();
  const messages: ChatMessage[] = [];

  for (const page of [...window.pages].reverse()) {
    for (const message of page.messages) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      messages.push(message);
    }
  }

  return messages;
}

function buildNewestFirstPages(
  messages: ChatMessage[],
  hasOlder: boolean,
): MessagePage[] {
  const pages: MessagePage[] = [];
  for (let end = messages.length; end > 0; end -= MESSAGE_PAGE_SIZE) {
    const start = Math.max(0, end - MESSAGE_PAGE_SIZE);
    pages.push({
      messages: messages.slice(start, end),
      hasOlder: false,
    });
  }
  if (pages.length === 0) {
    pages.push({ messages: [], hasOlder });
  } else {
    pages[pages.length - 1].hasOlder = hasOlder;
  }
  return pages;
}

function oldestMessageCursor(messages: ChatMessage[]) {
  return messages[0]?.createdAt;
}

function buildPageParams(pages: MessagePage[]) {
  return pages.map((_, index) =>
    index === 0 ? null : oldestMessageCursor(pages[index - 1].messages) ?? null,
  );
}
