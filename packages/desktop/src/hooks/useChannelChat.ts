import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  hashKey,
  useInfiniteQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
  type InfiniteData,
} from "@tanstack/react-query";
import type { AuthUser, ChatMessage } from "@thechat/shared";
import { api } from "../lib/api";
import { authHeaders, edenErrorMessage } from "../lib/eden";
import { wsEvents, type WsEvents } from "../lib/ws-events";

const MESSAGE_CACHE_TTL_MS = 60_000;
export const MESSAGE_PAGE_SIZE = 20;
export const MESSAGE_WINDOW_SIZE = 120;
export const MESSAGE_WINDOW_TRIM_THRESHOLD = 160;

interface UseChannelChatOptions {
  conversationId: string | null;
  threadId?: string | null;
  unthreadedOnly?: boolean;
  token: string | null;
  wsSendMessage: (
    conversationId: string,
    content: string,
    threadId?: string | null,
    clientMessageId?: string,
  ) => void;
  selfUser?: AuthUser | null;
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

interface LocalSentMessage {
  clientMessageId: string;
  message: ChatMessage;
  confirmed: boolean;
}

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
  selfUser = null,
}: UseChannelChatOptions) {
  const queryClient = useQueryClient();
  const [localSentMessages, setLocalSentMessages] = useState<LocalSentMessage[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);
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

  // Older pages accumulate while the user scrolls up. Rendering them all
  // again when the user returns to a scope makes switching feel slow, so
  // unload a scope's history back to the initial page on switch-away.
  const activeKeyRef = useRef<QueryKey | null>(null);
  useEffect(() => {
    const key = conversationId
      ? messagesQueryKey(conversationId, threadId, unthreadedOnly)
      : null;
    const previousKey = activeKeyRef.current;
    if (previousKey && (!key || hashKey(previousKey) !== hashKey(key))) {
      trimCachedWindowToInitialPage(queryClient, previousKey);
    }
    activeKeyRef.current = key;
  }, [conversationId, queryClient, threadId, unthreadedOnly]);

  useEffect(() => {
    return () => {
      if (activeKeyRef.current) {
        trimCachedWindowToInitialPage(queryClient, activeKeyRef.current);
      }
    };
  }, [queryClient]);

  const addMessage = useCallback(
    (msg: ChatMessage, clientMessageId?: string) => {
      if (msg.conversationId !== conversationId) return;
      setLocalSentMessages((previous) =>
        clientMessageId
          ? confirmLocalSentMessage(previous, clientMessageId, msg)
          : confirmMatchingLiveEcho(previous, msg),
      );

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

  const addOptimisticSentMessage = useCallback(
    (content: string, targetThreadId: string | null = threadId ?? null) => {
      if (!conversationId) return null;
      const localMessage = createLocalSentMessage(
        conversationId,
        targetThreadId,
        content,
        selfUser,
      );
      if (!localMessage) return null;
      setSendError(null);
      setLocalSentMessages((previous) =>
        appendLocalSentMessage(previous, localMessage),
      );
      return localMessage.clientMessageId;
    },
    [conversationId, selfUser, threadId],
  );

  const sendMessage = useCallback(
    (content: string) => {
      if (!conversationId) return null;
      const clientMessageId = addOptimisticSentMessage(content, threadId ?? null);
      if (clientMessageId) {
        wsSendMessage(conversationId, content, threadId ?? null, clientMessageId);
      } else {
        wsSendMessage(conversationId, content, threadId ?? null);
      }
      return clientMessageId;
    },
    [addOptimisticSentMessage, conversationId, threadId, wsSendMessage],
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

  useEffect(() => {
    const onMessageError = ({
      conversationId: failedConversationId,
      clientMessageId,
      message,
    }: WsEvents["ws:message_error"]) => {
      if (failedConversationId !== conversationId) return;
      setLocalSentMessages((previous) =>
        previous.filter((local) => local.clientMessageId !== clientMessageId),
      );
      setSendError(message);
    };

    wsEvents.on("ws:message_error", onMessageError);
    return () => {
      wsEvents.off("ws:message_error", onMessageError);
    };
  }, [conversationId]);

  // A live echo can arrive while an older history request is still running.
  // Keep its server payload locally until that request settles, then restore it
  // to the active cache before dropping the local overlay.
  useEffect(() => {
    if (!conversationId || query.isFetching) return;
    const key = messagesQueryKey(conversationId, threadId, unthreadedOnly);
    if (queryClient.isFetching({ queryKey: key, exact: true }) > 0) return;

    const confirmedInScope = localSentMessages.filter(
      (local) =>
        local.confirmed &&
        local.message.conversationId === conversationId &&
        messageBelongsToScope(local.message, threadId, unthreadedOnly),
    );
    if (confirmedInScope.length === 0) return;

    queryClient.setQueryData<MessageWindow>(key, (previous) =>
      confirmedInScope.reduce(
        (window, local) => appendMessageToWindow(window, local.message),
        previous,
      ),
    );
    const restoredIds = new Set(
      confirmedInScope.map((local) => local.clientMessageId),
    );
    setLocalSentMessages((previous) =>
      previous.filter((local) => !restoredIds.has(local.clientMessageId)),
    );
  }, [
    conversationId,
    localSentMessages,
    query.isFetching,
    queryClient,
    threadId,
    unthreadedOnly,
  ]);

  useEffect(() => {
    setLocalSentMessages([]);
    setSendError(null);
  }, [conversationId]);

  const messages = useMemo(
    () =>
      appendVisibleLocalMessages(
        flattenMessageWindow(query.data),
        localSentMessages,
        conversationId,
        threadId,
        unthreadedOnly,
      ),
    [conversationId, localSentMessages, query.data, threadId, unthreadedOnly],
  );

  return {
    messages,
    loading: query.isLoading,
    loadingOlder: query.isFetchingNextPage,
    hasOlderMessages: query.hasNextPage,
    addMessage,
    addOptimisticSentMessage,
    sendMessage,
    sendError,
    refetchMessages,
    loadOlderMessages,
  };
}

function createLocalSentMessage(
  conversationId: string,
  threadId: string | null,
  content: string,
  selfUser: AuthUser | null,
): LocalSentMessage | null {
  if (!selfUser) return null;
  const clientMessageId = newClientMessageId();
  return {
    clientMessageId,
    confirmed: false,
    message: {
      id: `optimistic:${clientMessageId}`,
      conversationId,
      threadId,
      senderId: selfUser.id,
      senderName: selfUser.name,
      senderType: selfUser.type,
      content,
      parts: null,
      createdAt: new Date().toISOString(),
    },
  };
}

function appendMessage(messages: ChatMessage[], msg: ChatMessage) {
  if (messages.some((m) => m.id === msg.id)) return messages;
  return [...messages, msg];
}

function appendLocalSentMessage(
  messages: LocalSentMessage[],
  message: LocalSentMessage,
) {
  if (
    messages.some(
      (candidate) => candidate.clientMessageId === message.clientMessageId,
    )
  ) {
    return messages;
  }
  return [...messages, message];
}

function confirmLocalSentMessage(
  messages: LocalSentMessage[],
  clientMessageId: string,
  serverMessage: ChatMessage,
) {
  const index = messages.findIndex(
    (candidate) => candidate.clientMessageId === clientMessageId,
  );
  if (index < 0) return messages;
  const confirmed: LocalSentMessage = {
    clientMessageId,
    message: serverMessage,
    confirmed: true,
  };
  return [...messages.slice(0, index), confirmed, ...messages.slice(index + 1)];
}

function confirmMatchingLiveEcho(
  messages: LocalSentMessage[],
  serverMessage: ChatMessage,
) {
  const index = messages.findIndex(
    (candidate) =>
      !candidate.confirmed &&
      candidate.message.conversationId === serverMessage.conversationId &&
      candidate.message.threadId === serverMessage.threadId &&
      candidate.message.senderId === serverMessage.senderId &&
      candidate.message.content === serverMessage.content,
  );
  if (index < 0) return messages;
  const local = messages[index];
  const confirmed: LocalSentMessage = {
    ...local,
    message: serverMessage,
    confirmed: true,
  };
  return [...messages.slice(0, index), confirmed, ...messages.slice(index + 1)];
}

function appendVisibleLocalMessages(
  messages: ChatMessage[],
  localMessages: LocalSentMessage[],
  conversationId: string | null,
  threadId: string | null,
  unthreadedOnly: boolean,
) {
  let next = messages;
  for (const local of localMessages) {
    if (local.message.conversationId !== conversationId) continue;
    if (!messageBelongsToScope(local.message, threadId, unthreadedOnly)) continue;
    next = appendMessage(next, local.message);
  }
  return next;
}

function messageBelongsToScope(
  msg: ChatMessage,
  threadId: string | null,
  unthreadedOnly: boolean,
) {
  if (threadId) return msg.threadId === threadId;
  if (unthreadedOnly) return msg.threadId === null;
  return true;
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
  const nextWindow = { ...window, pages };
  return trimWindowToRecentMessages(nextWindow, MESSAGE_WINDOW_TRIM_THRESHOLD) ?? nextWindow;
}

function newClientMessageId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function trimCachedWindowToInitialPage(queryClient: QueryClient, key: QueryKey) {
  const window = queryClient.getQueryData<MessageWindow>(key);
  if (!window) return;
  const messages = flattenMessageWindow(window);
  if (messages.length <= MESSAGE_PAGE_SIZE) return;
  queryClient.setQueryData<MessageWindow>(key, {
    pages: [{ messages: messages.slice(-MESSAGE_PAGE_SIZE), hasOlder: true }],
    pageParams: [null],
  });
}

function trimWindowToRecentMessages(
  window: MessageWindow | undefined,
  trimThreshold = MESSAGE_WINDOW_SIZE,
): MessageWindow | undefined {
  if (!window) return window;
  if (countWindowMessages(window) <= trimThreshold) return window;

  const messages = flattenMessageWindow(window);

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

function countWindowMessages(window: MessageWindow) {
  return window.pages.reduce((count, page) => count + page.messages.length, 0);
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
