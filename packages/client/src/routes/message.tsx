import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { MessageContext } from "@thechat/shared";
import { ArrowLeft, ArrowUpRight, Hash, ListTodo, MessagesSquare } from "lucide-react";
import { Markdown } from "../components/Markdown";
import { SharedChatMessage, shouldMergeChatMessage } from "../components/SharedChatMessage";
import { buttonClass } from "../components/ui";
import { fetchMessageContext, SearchRequestError } from "../lib/search-api";
import { openSearchLocation, JumpSupersededError } from "../lib/search-navigation";
import { openReplyThread } from "../lib/open-reply-thread";
import { useAuthStore } from "../stores/auth";

/** Messages shown on each side of the target. */
const CONTEXT_SIZE = 25;

export const messageContextQueryKey = (messageId: string) => ["message-context", messageId] as const;

/**
 * One message in its surroundings: what a search result or a shared message
 * link opens. Read-only, so it works for messages far back in history; "Open
 * conversation" continues in the live chat.
 */
export function MessageContextRoute() {
  const { messageId } = useParams({ from: "/message/$messageId" });
  const signedIn = useAuthStore((state) => Boolean(state.user));
  const query = useQuery({
    queryKey: messageContextQueryKey(messageId),
    queryFn: ({ signal }) => fetchMessageContext(messageId, { before: CONTEXT_SIZE, after: CONTEXT_SIZE }, signal),
    enabled: signedIn,
    staleTime: 60_000,
    retry: (count, error) => !(error instanceof SearchRequestError && error.status === 404) && count < 1,
  });

  if (query.isPending) {
    return <div className="flex h-full items-center justify-center text-[0.929rem] text-text-dimmed">Loading message…</div>;
  }
  if (query.isError) {
    const notFound = query.error instanceof SearchRequestError && query.error.status === 404;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-[0.929rem] text-text-muted">
          {notFound ? "This message does not exist or you cannot see it." : query.error.message}
        </p>
        {!notFound && (
          <button type="button" className={buttonClass("secondary", "md")} onClick={() => void query.refetch()}>
            Try again
          </button>
        )}
      </div>
    );
  }
  return <MessageContextView context={query.data} />;
}

export function MessageContextView({ context }: { context: MessageContext }) {
  const navigate = useNavigate();
  const targetRef = useRef<HTMLDivElement>(null);
  const replyRootId = context.replyRootId ?? null;
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const { conversation } = context;

  // Put the target in view before the first paint: no visible jump.
  useLayoutEffect(() => {
    targetRef.current?.scrollIntoView({ block: "center" });
  }, [context.targetMessageId]);

  useEffect(() => {
    setOpenError(null);
  }, [context.targetMessageId]);

  const rows = useMemo(
    () =>
      context.messages.map((message, index) => ({
        message,
        merged: shouldMergeChatMessage(context.messages[index - 1], message),
        target: message.id === context.targetMessageId,
      })),
    [context.messages, context.targetMessageId],
  );

  const openConversation = async () => {
    setOpening(true);
    setOpenError(null);
    try {
      if (replyRootId) {
        // A reply: open its conversation with the thread beside it.
        await openReplyThread(navigate, {
          workspaceId: conversation.workspaceId,
          workspaceName: conversation.workspaceName,
          conversationId: conversation.id,
          conversationType: conversation.type,
          rootMessageId: replyRootId,
          highlightMessageId:
            context.targetMessageId === replyRootId ? null : context.targetMessageId,
        });
        return;
      }
      await openSearchLocation({
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        conversationType: conversation.type,
        threadId: context.threadId,
        // The live chat opens scrolled to this message, highlighted.
        messageId: context.targetMessageId,
      });
    } catch (error) {
      if (!(error instanceof JumpSupersededError)) {
        setOpenError(error instanceof Error ? error.message : "Could not open the conversation");
      }
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-base" data-testid="message-context">
      <div data-testid="message-context-header" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle px-5 py-2.5">
        <button
          type="button"
          className={buttonClass("ghost", "sm")}
          onClick={() => window.history.back()}
          aria-label="Back"
          title="Back"
        >
          <ArrowLeft size={14} aria-hidden="true" />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[0.929rem]">
          {conversation.type === "group" && <Hash size={14} className="shrink-0 text-text-dimmed" aria-hidden="true" />}
          <span className="truncate font-semibold text-text">{conversation.name}</span>
          {context.threadTitle && (
            <>
              <ListTodo size={14} className="ml-1 shrink-0 text-text-dimmed" aria-hidden="true" />
              <span className="truncate text-text-muted">{context.threadTitle}</span>
            </>
          )}
          {replyRootId && (
            <>
              <MessagesSquare size={14} className="ml-1 shrink-0 text-text-dimmed" aria-hidden="true" />
              <span className="truncate text-text-muted">Thread</span>
            </>
          )}
          <span className="ml-1 hidden shrink-0 text-[0.786rem] text-text-dimmed sm:inline">· {conversation.workspaceName}</span>
        </div>
        <button
          type="button"
          className={buttonClass("primary", "sm")}
          onClick={() => void openConversation()}
          disabled={opening}
        >
          {replyRootId ? "Open thread" : context.threadId ? "Open task" : "Open conversation"}
          <ArrowUpRight size={14} aria-hidden="true" />
        </button>
      </div>
      {openError && (
        <div role="alert" className="shrink-0 border-b border-error-msg-border bg-error-msg-bg px-5 py-2 text-[0.857rem] text-error-bright">
          {openError}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto py-3">
        {context.hasOlder && (
          <div className="px-5 pb-2 text-center text-[0.786rem] text-text-dimmed">Earlier messages are in the conversation</div>
        )}
        {rows.map(({ message, merged, target }) => (
          <div
            key={message.id}
            ref={target ? targetRef : undefined}
            data-search-target={target ? "true" : undefined}
            className={target ? "border-l-[3px] border-accent bg-accent/[0.12]" : "border-l-[3px] border-transparent"}
          >
            <SharedChatMessage message={message} merged={merged && !target}>
              {message.content && <Markdown content={message.content} message={message} />}
            </SharedChatMessage>
          </div>
        ))}
        {context.hasNewer && (
          <div className="px-5 pt-2 text-center text-[0.786rem] text-text-dimmed">Later messages are in the conversation</div>
        )}
      </div>
    </div>
  );
}
