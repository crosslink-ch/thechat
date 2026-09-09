import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAuthStore } from "../stores/auth";
import { useActivityStore } from "../stores/activity";
import { sessionGeneration } from "../lib/session-boundary";
import { getMessageContext } from "../lib/search-api";
import { requestInputBarFocus } from "../stores/input-focus";
import { SharedChatMessage, shouldMergeChatMessage } from "./SharedChatMessage";
import { Markdown } from "./Markdown";

type ContextProps = {
  conversationId: string;
  threadId?: string | null;
  messageId: string;
  route: "/dm/$id" | "/channel/$id";
};
/** A separate bounded snapshot, never merged into the latest-window query cache. */
export function MessageContextView(props: ContextProps) {
  const userId = useAuthStore((s) => s.user?.id);
  const token = useAuthStore((s) => s.token);
  return (
    <ContextWindow
      key={JSON.stringify([
        props.conversationId,
        props.threadId,
        props.messageId,
        userId,
        token,
      ])}
      {...props}
      token={token}
    />
  );
}
function ContextWindow({
  conversationId,
  threadId,
  messageId,
  route,
  token,
}: ContextProps & { token: string | null }) {
  const navigate = useNavigate();
  const [context, setContext] = useState<Awaited<
    ReturnType<typeof getMessageContext>
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const highlighted = useRef<HTMLDivElement>(null);
  const markRead = useActivityStore((s) => s.markConversationRead);
  const generation = sessionGeneration();
  useEffect(() => {
    let cancelled = false;
    getMessageContext(messageId, token)
      .then((data) => {
        if (cancelled || generation !== sessionGeneration()) return;
        if (
          data.conversationId !== conversationId ||
          data.threadId !== (threadId ?? null) ||
          !data.messages.some((message) => message.id === messageId)
        ) {
          throw new Error("This message is unavailable in this conversation.");
        }
        setContext(data);
      })
      .catch((cause: unknown) => {
        if (!cancelled && generation === sessionGeneration())
          setError(
            cause instanceof Error
              ? cause.message
              : "This message is unavailable.",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, threadId, messageId, token, generation]);
  useLayoutEffect(() => {
    if (!context) return;
    highlighted.current?.scrollIntoView({ block: "center" });
    highlighted.current?.focus({ preventScroll: true });
  }, [context]);
  useEffect(() => {
    if (
      !context ||
      !viewport.current ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    let active = true;
    const visible = new Set<string>();
    const acknowledged = new Set<string>();
    const flush = () => {
      if (
        !active ||
        generation !== sessionGeneration() ||
        document.visibilityState !== "visible"
      )
        return;
      const ids = [...visible].filter((id) => !acknowledged.has(id));
      if (!ids.length) return;
      ids.forEach((id) => acknowledged.add(id));
      void markRead(conversationId, ids).catch(() => {
        ids.forEach((id) => acknowledged.delete(id));
      });
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.messageId;
          if (!id || id.startsWith("optimistic:")) continue;
          if (entry.isIntersecting && entry.intersectionRatio > 0)
            visible.add(id);
          else visible.delete(id);
        }
        flush();
      },
      { root: viewport.current, threshold: [0, 0.01] },
    );
    viewport.current
      .querySelectorAll("[data-message-id]")
      .forEach((row) => observer.observe(row));
    document.addEventListener("visibilitychange", flush);
    return () => {
      active = false;
      observer.disconnect();
      document.removeEventListener("visibilitychange", flush);
    };
  }, [context, conversationId, generation, markRead]);
  async function backToLatest() {
    await navigate({
      to: route,
      params: { id: conversationId },
      search: {
        threadId: context?.threadId ?? threadId ?? undefined,
        messageId: undefined,
        jump: crypto.randomUUID(),
      },
    });
    requestInputBarFocus();
  }
  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col text-text"
      aria-label="Message context"
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-elevated px-4 py-3">
        <div>
          <h1 className="text-sm font-semibold">
            Message context{threadId ? " · Task" : ""}
          </h1>
          <p className="text-xs text-text-muted">
            A snapshot around the selected message, not live chat.
          </p>
        </div>
        <button
          onClick={() => void backToLatest()}
          className="rounded border border-border bg-surface px-3 py-2 text-sm hover:bg-hover"
        >
          Back to latest
        </button>
      </div>
      {error ? (
        <p role="alert" className="p-4 text-error-bright">
          {error}
        </p>
      ) : !context ? (
        <p role="status" className="p-4 text-text-muted">
          Loading message context...
        </p>
      ) : null}
      <div
        ref={viewport}
        data-testid="message-context-scroll"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none]"
      >
        {context?.hasOlder && (
          <p className="px-4 py-3 text-center text-xs text-text-dimmed">
            Earlier messages are outside this context
          </p>
        )}
        {context?.messages.map((message, index) => (
          <div
            key={message.id}
            ref={message.id === messageId ? highlighted : undefined}
            tabIndex={message.id === messageId ? -1 : undefined}
            aria-label={
              message.id === messageId ? "Selected search message" : undefined
            }
            data-highlighted-message={
              message.id === messageId ? messageId : undefined
            }
            className={
              message.id === messageId
                ? "rounded border-l-4 border-border-focus bg-elevated outline-none ring-1 ring-inset ring-border-focus"
                : undefined
            }
          >
            <SharedChatMessage
              message={message}
              merged={
                message.id !== messageId &&
                shouldMergeChatMessage(context.messages[index - 1], message)
              }
            >
              <div className="break-words text-sm text-text">
                <Markdown content={message.content} />
              </div>
            </SharedChatMessage>
          </div>
        ))}
        {context?.hasNewer && (
          <p className="px-4 py-3 text-center text-xs text-text-dimmed">
            Newer messages are outside this context
          </p>
        )}
      </div>
    </section>
  );
}
