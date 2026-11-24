import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import type {
  AuthUser,
  ChatMessage,
  MessageThreadPage,
  MessageThreadSummary,
} from "@thechat/shared";
import { api } from "../lib/api";
import { authHeaders, edenErrorMessage } from "../lib/eden";
import { isAuthenticated } from "../lib/auth-identity";
import { cacheRootThreadSummary } from "./useChannelChat";
import {
  messageRequestBody,
  messageText,
  optimisticParts,
  type MessageInput,
} from "../lib/composer-parts";

type ThreadWindow = InfiniteData<MessageThreadPage, string | null>;

export const messageThreadQueryKey = (conversationId: string, rootMessageId: string) =>
  ["message-thread", conversationId, rootMessageId] as const;

/** Server replies acknowledged for a client-generated send ID. */
const acknowledgedClientIds = new Map<string, string>();

function appendReply(window: ThreadWindow | undefined, reply: ChatMessage, summary?: MessageThreadSummary) {
  if (!window || window.pages.length === 0) return window;
  const exists = window.pages.some((page) => page.replies.some((item) => item.id === reply.id));
  const pages = window.pages.map((page, index) => {
    if (index !== 0) return page;
    return {
      ...page,
      root: summary ? { ...page.root, thread: summary } : page.root,
      replies: exists ? page.replies : [...page.replies, reply],
    };
  });
  return { ...window, pages };
}

/** Add a live reply to its open thread (if that thread was loaded). */
export function cacheIncomingThreadReply(
  queryClient: QueryClient,
  message: ChatMessage,
  rootThread?: MessageThreadSummary,
  clientMessageId?: string,
) {
  if (!message.parentMessageId) return;
  if (clientMessageId) acknowledgedClientIds.set(clientMessageId, message.id);
  queryClient.setQueryData<ThreadWindow>(
    messageThreadQueryKey(message.conversationId, message.parentMessageId),
    (previous) => appendReply(previous, message, rootThread),
  );
}

/** Reflect a follow change made here or on another device. */
export function cacheThreadFollowing(
  queryClient: QueryClient,
  conversationId: string,
  rootMessageId: string,
  following: boolean,
) {
  queryClient.setQueryData<ThreadWindow>(
    messageThreadQueryKey(conversationId, rootMessageId),
    (previous) =>
      previous
        ? {
            ...previous,
            pages: previous.pages.map((page, index) =>
              index === 0 ? { ...page, following } : page,
            ),
          }
        : previous,
  );
}

async function fetchThreadPage(
  conversationId: string,
  rootMessageId: string,
  token: string | null,
  before: string | null,
): Promise<MessageThreadPage> {
  const { data, error } = await api
    .messages({ conversationId })
    .threads({ rootMessageId })
    .get({ query: before ? { before } : {}, ...authHeaders(token) });
  if (error || !data || !("root" in data)) {
    throw new Error(edenErrorMessage(error, "Failed to load the thread"));
  }
  return data as MessageThreadPage;
}

interface LocalReply {
  clientMessageId: string;
  message: ChatMessage;
}

/** One reply thread: its root, replies, follow state and a reply sender. */
export function useMessageThread({
  conversationId,
  rootMessageId,
  token,
  selfUser,
}: {
  conversationId: string | null;
  rootMessageId: string | null;
  token: string | null;
  selfUser: AuthUser | null;
}) {
  const queryClient = useQueryClient();
  const [localReplies, setLocalReplies] = useState<LocalReply[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);
  const [followPending, setFollowPending] = useState(false);
  const enabled = Boolean(conversationId && rootMessageId && isAuthenticated(token));

  const query = useInfiniteQuery<
    MessageThreadPage,
    Error,
    ThreadWindow,
    readonly unknown[],
    string | null
  >({
    queryKey: enabled
      ? messageThreadQueryKey(conversationId!, rootMessageId!)
      : ["message-thread", "disabled"],
    queryFn: ({ pageParam }) =>
      fetchThreadPage(conversationId!, rootMessageId!, token, pageParam),
    initialPageParam: null,
    getNextPageParam: (lastPage) =>
      lastPage.hasOlder ? (lastPage.replies[0]?.createdAt ?? undefined) : undefined,
    enabled,
    staleTime: 0,
  });

  useEffect(() => {
    setLocalReplies([]);
    setSendError(null);
  }, [conversationId, rootMessageId]);

  const firstPage = query.data?.pages[0];
  const replies = useMemo(() => {
    const seen = new Set<string>();
    const result: ChatMessage[] = [];
    for (const page of [...(query.data?.pages ?? [])].reverse()) {
      for (const reply of page.replies) {
        if (seen.has(reply.id)) continue;
        seen.add(reply.id);
        result.push(reply);
      }
    }
    for (const local of localReplies) {
      const acknowledged = acknowledgedClientIds.get(local.clientMessageId);
      if (acknowledged && seen.has(acknowledged)) continue;
      result.push(local.message);
    }
    return result;
  }, [localReplies, query.data]);

  const sendReply = useCallback(
    async (content: MessageInput, attachmentIds: string[] = [], alsoSendToConversation = false) => {
      if (!conversationId || !rootMessageId || !isAuthenticated(token)) return false;
      const clientMessageId = globalThis.crypto?.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      if (selfUser) {
        setLocalReplies((previous) => [
          ...previous,
          {
            clientMessageId,
            message: {
              id: `optimistic:${clientMessageId}`,
              conversationId,
              threadId: firstPage?.root.threadId ?? null,
              parentMessageId: rootMessageId,
              senderId: selfUser.id,
              senderName: selfUser.name,
              senderType: selfUser.type,
              content: messageText(content),
              ...optimisticParts(content),
              attachments: [],
              createdAt: new Date().toISOString(),
            },
          },
        ]);
      }
      setSendError(null);
      const dropLocal = () =>
        setLocalReplies((previous) =>
          previous.filter((local) => local.clientMessageId !== clientMessageId),
        );
      try {
        const { data, error } = await api.messages({ conversationId }).post(
          {
            clientMessageId,
            ...messageRequestBody(content),
            parentMessageId: rootMessageId,
            alsoSendToConversation,
            attachmentIds,
          },
          authHeaders(token),
        );
        if (error || !data || !("id" in data)) {
          dropLocal();
          setSendError(edenErrorMessage(error, "Failed to send reply"));
          return false;
        }
        acknowledgedClientIds.set(clientMessageId, data.id);
        cacheIncomingThreadReply(queryClient, data as ChatMessage);
        dropLocal();
        return true;
      } catch (caught) {
        dropLocal();
        setSendError(caught instanceof Error ? caught.message : "Failed to send reply");
        return false;
      }
    },
    [conversationId, firstPage?.root.threadId, queryClient, rootMessageId, selfUser, token],
  );

  const setFollowing = useCallback(
    async (following: boolean) => {
      if (!conversationId || !rootMessageId || !isAuthenticated(token)) return;
      setFollowPending(true);
      const previous = firstPage?.following ?? false;
      cacheThreadFollowing(queryClient, conversationId, rootMessageId, following);
      try {
        const { error } = await api
          .messages({ conversationId })
          .threads({ rootMessageId })
          .follow.post({ following }, authHeaders(token));
        if (error) throw new Error(edenErrorMessage(error, "Could not update the thread"));
      } catch (caught) {
        cacheThreadFollowing(queryClient, conversationId, rootMessageId, previous);
        setSendError(caught instanceof Error ? caught.message : "Could not update the thread");
      } finally {
        setFollowPending(false);
      }
    },
    [conversationId, firstPage?.following, queryClient, rootMessageId, token],
  );

  const setReaction = useCallback(
    async (messageId: string, emoji: string, active: boolean) => {
      if (!conversationId || !isAuthenticated(token)) throw new Error("Authentication required");
      const { data, error } = await api
        .messages({ conversationId })({ messageId })
        .reactions.post({ emoji, active }, authHeaders(token));
      if (error || !data || !("reactions" in data)) {
        throw new Error(edenErrorMessage(error, "Failed to update reaction"));
      }
      void queryClient.invalidateQueries({ queryKey: ["message-thread", conversationId] });
      void queryClient.invalidateQueries({ queryKey: ["messages", conversationId] });
    },
    [conversationId, queryClient, token],
  );

  // Keep the root's summary in the timeline in step with what the thread shows.
  useEffect(() => {
    if (!conversationId || !firstPage?.root.thread) return;
    cacheRootThreadSummary(queryClient, conversationId, firstPage.root.id, firstPage.root.thread);
  }, [conversationId, firstPage?.root.id, firstPage?.root.thread, queryClient]);

  return {
    root: firstPage?.root ?? null,
    replies,
    following: firstPage?.following ?? false,
    loading: enabled && query.isLoading,
    error: query.error?.message ?? null,
    hasOlder: query.hasNextPage,
    loadingOlder: query.isFetchingNextPage,
    loadOlder: () => void query.fetchNextPage(),
    sendReply,
    sendError,
    setFollowing,
    followPending,
    setReaction,
  };
}
