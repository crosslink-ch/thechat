import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import type { ChatMessage, FollowedThread, FollowedThreadsPage } from "@thechat/shared";
import { Hash, MessagesSquare } from "lucide-react";
import { api } from "../lib/api";
import { authHeaders, edenErrorMessage } from "../lib/eden";
import { isAuthenticated } from "../lib/auth-identity";
import { wsEvents } from "../lib/ws-events";
import { openReplyThread } from "../lib/open-reply-thread";
import { useAuthStore } from "../stores/auth";
import { useActivityStore } from "../stores/activity";
import { useWorkspacesStore } from "../stores/workspaces";
import { Avatar } from "../components/Avatar";
import { relativeReplyTime } from "../components/ThreadReplySummary";
import { buttonClass } from "../components/ui";

const PAGE_SIZE = 20;

export const followedThreadsQueryKey = (userId: string | undefined, workspaceId: string | null) =>
  ["followed-threads", userId ?? "anonymous", workspaceId ?? "all"] as const;

function preview(message: ChatMessage) {
  const content = message.content.trim();
  if (content) return content;
  return message.attachments?.length ? "Sent an attachment" : "";
}

function ThreadMessageLine({ message, dimmed = false }: { message: ChatMessage; dimmed?: boolean }) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <Avatar
        aria-hidden="true"
        name={message.senderName}
        colorKey={message.senderId}
        bot={message.senderType === "bot"}
        size={20}
        className="mt-0.5 size-5 shrink-0 text-[0.643rem]"
      />
      <div className={`min-w-0 flex-1 text-[0.929rem] ${dimmed ? "text-text-muted" : "text-text-secondary"}`}>
        <span className="font-semibold text-text">{message.senderName}</span>{" "}
        <span className="text-[0.786rem] text-text-dimmed">{relativeReplyTime(message.createdAt)}</span>
        <div className="line-clamp-2 break-words">{preview(message)}</div>
      </div>
    </div>
  );
}

/**
 * Every thread the signed-in user follows, most recent reply first (like
 * Slack's Threads view). Each card opens the thread beside its conversation.
 */
export function ThreadsRoute() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const token = useAuthStore((state) => state.token);
  const user = useAuthStore((state) => state.user);
  const workspaceId = useWorkspacesStore((state) => state.activeWorkspace?.id ?? null);
  const unreadThreads = useActivityStore((state) => state.threads);
  const [openError, setOpenError] = useState<string | null>(null);
  const queryKey = followedThreadsQueryKey(user?.id, workspaceId);

  const query = useInfiniteQuery<
    FollowedThreadsPage,
    Error,
    InfiniteData<FollowedThreadsPage, string | undefined>,
    typeof queryKey,
    string | undefined
  >({
    queryKey,
    enabled: isAuthenticated(token),
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => {
      const { data, error } = await api.activity.threads.get({
        ...authHeaders(token),
        query: {
          ...(workspaceId ? { workspaceId } : {}),
          ...(pageParam ? { before: pageParam } : {}),
          limit: PAGE_SIZE,
        },
      });
      if (error) throw new Error(edenErrorMessage(error, "Couldn't load threads"));
      return data as FollowedThreadsPage;
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

  // New replies and follow changes reorder the list: refetch it.
  useEffect(() => {
    const refresh = () => void queryClient.invalidateQueries({ queryKey: ["followed-threads"] });
    const onMessage = ({ message }: { message: ChatMessage }) => {
      if (message.parentMessageId) refresh();
    };
    wsEvents.on("ws:new_message", onMessage);
    wsEvents.on("ws:thread_follow_updated", refresh);
    return () => {
      wsEvents.off("ws:new_message", onMessage);
      wsEvents.off("ws:thread_follow_updated", refresh);
    };
  }, [queryClient]);

  const unreadByRoot = new Map(unreadThreads.map((thread) => [thread.rootMessageId, thread.unreadCount]));
  const threads = query.data?.pages.flatMap((page) => page.items) ?? [];

  const open = async (thread: FollowedThread) => {
    setOpenError(null);
    try {
      const unread = unreadByRoot.get(thread.root.id) ?? 0;
      await openReplyThread(navigate, {
        workspaceId: thread.workspaceId,
        workspaceName: thread.workspaceName,
        conversationId: thread.conversationId,
        conversationType: thread.conversationType,
        rootMessageId: thread.root.id,
        // With unread replies, land on the first one shown here.
        highlightMessageId: unread > 0 ? thread.latestReplies.at(-unread)?.id ?? null : null,
      });
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : "Couldn't open this thread");
    }
  };

  const error = openError ?? query.error?.message ?? null;

  return (
    <div className="flex h-full flex-col bg-base">
      <div className="shrink-0 px-4 pb-4 pt-6 sm:px-8 sm:pt-8">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-[1.429rem] font-semibold tracking-tight text-text">Threads</h1>
          <p className="mt-1 text-[0.929rem] text-text-muted">
            Threads you started, replied to, were mentioned in, or follow.
          </p>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 pb-10 pt-2 sm:px-8">
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {error && (
            <div
              role="alert"
              className="rounded-lg border border-error-msg-border bg-error-msg-bg px-3 py-2 text-[0.929rem] text-error-bright"
            >
              {error}
            </div>
          )}
          {query.isLoading && (
            <div className="rounded-xl border border-border bg-white/[0.03] px-4 py-8 text-center text-[0.929rem] text-text-dimmed">
              Loading threads...
            </div>
          )}
          {!query.isLoading && !query.error && threads.length === 0 && (
            <div className="py-16 text-center">
              <MessagesSquare size={28} aria-hidden="true" className="mx-auto mb-3 text-text-dimmed" />
              <div className="text-[1rem] font-medium text-text-secondary">No threads yet</div>
              <div className="mt-1 text-[0.929rem] text-text-dimmed">
                Reply to a message in a channel or DM to start one.
              </div>
            </div>
          )}
          {threads.map((thread) => {
            const unread = unreadByRoot.get(thread.root.id) ?? 0;
            const hiddenReplies = thread.replyCount - thread.latestReplies.length;
            return (
              <article
                key={thread.root.id}
                data-testid={`followed-thread-${thread.root.id}`}
                className={`rounded-xl border bg-white/[0.03] transition-colors duration-150 hover:bg-white/[0.05] ${
                  unread > 0 ? "border-accent/40" : "border-border"
                }`}
              >
                <button
                  type="button"
                  className="block w-full cursor-pointer border-none bg-transparent p-4 text-left"
                  aria-label={`Open thread in ${thread.conversationType === "group" ? "#" : ""}${thread.conversationName}`}
                  onClick={() => void open(thread)}
                >
                  <div className="mb-2.5 flex items-center gap-1.5 text-[0.857rem]">
                    {thread.conversationType === "group" ? (
                      <Hash size={13} aria-hidden="true" className="text-text-dimmed" />
                    ) : null}
                    <span className="truncate font-semibold text-text">{thread.conversationName}</span>
                    <span className="truncate text-text-dimmed">{thread.workspaceName}</span>
                    {unread > 0 && (
                      <span className="ml-auto shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[0.786rem] font-medium text-accent">
                        {unread} new
                      </span>
                    )}
                  </div>
                  <ThreadMessageLine message={thread.root} />
                  <div className="ml-2.5 mt-2.5 flex flex-col gap-2 border-l-2 border-border pl-4">
                    {hiddenReplies > 0 && (
                      <div className="text-[0.786rem] font-medium text-accent">
                        {hiddenReplies} more {hiddenReplies === 1 ? "reply" : "replies"}
                      </div>
                    )}
                    {thread.latestReplies.map((reply) => (
                      <ThreadMessageLine key={reply.id} message={reply} dimmed />
                    ))}
                  </div>
                </button>
              </article>
            );
          })}
          {query.hasNextPage && (
            <div className="flex justify-center pt-2">
              <button
                type="button"
                className={buttonClass("secondary", "sm")}
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage ? "Loading..." : "Load older threads"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
