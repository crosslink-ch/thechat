import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Bell, BellOff, Hash, X } from "lucide-react";
import { Markdown } from "./Markdown";
import { InputBar, type InputSendResult } from "./InputBar";
import { MessageSendError } from "./MessageSendError";
import { SharedChatMessage, shouldMergeChatMessage } from "./SharedChatMessage";
import type { MentionUser } from "./MentionList";
import { buttonClass, iconButtonClass } from "./ui";
import { useAuthStore } from "../stores/auth";
import { useActivityStore } from "../stores/activity";
import { composerDraftKey } from "../stores/composer-drafts";
import {
  clampThreadPanelWidth,
  THREAD_PANEL_MAX_WIDTH,
  THREAD_PANEL_MIN_WIDTH,
  useThreadPanelStore,
} from "../stores/thread-panel";
import { useMessageThread } from "../hooks/useMessageThread";
import { useMentionNames } from "../hooks/useMentionNames";
import { isAuthenticated } from "../lib/auth-identity";
import type { MessageInput } from "../lib/composer-parts";

const KEYBOARD_RESIZE_STEP = 24;

interface ThreadPanelProps {
  conversationId: string;
  conversationType: "direct" | "group";
  /** Channel name, or the other person's name in a DM. */
  conversationName: string;
  rootMessageId: string;
  mentions?: MentionUser[];
}

/**
 * The reply thread of one message, beside the conversation (Slack-style).
 * Resizable from its left edge by pointer or keyboard; the width persists.
 */
export function ThreadPanel({
  conversationId,
  conversationType,
  conversationName,
  rootMessageId,
  mentions,
}: ThreadPanelProps) {
  const token = useAuthStore((state) => state.token);
  const user = useAuthStore((state) => state.user);
  const width = useThreadPanelStore((state) => state.width);
  const setWidth = useThreadPanelStore((state) => state.setWidth);
  const loadWidth = useThreadPanelStore((state) => state.loadWidth);
  const closeThread = useThreadPanelStore((state) => state.closeThread);
  const focusNonce = useThreadPanelStore((state) => state.focusNonce);
  const highlightMessageId = useThreadPanelStore((state) => state.highlightMessageId);
  const markConversationRead = useActivityStore((state) => state.markConversationRead);
  const panelRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [alsoSend, setAlsoSend] = useState(false);

  const thread = useMessageThread({ conversationId, rootMessageId, token, selfUser: user });

  useEffect(() => {
    void loadWidth();
  }, [loadWidth]);

  useEffect(() => setAlsoSend(false), [rootMessageId]);

  // -- Resizing ---------------------------------------------------------------
  const containerWidth = () => panelRef.current?.parentElement?.getBoundingClientRect().width;
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onResizePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startX: event.clientX, startWidth: width };
    setDragging(true);
  };
  const onResizePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    // The handle is on the panel's left edge: dragging left widens it.
    setWidth(clampThreadPanelWidth(drag.startWidth + drag.startX - event.clientX, containerWidth()));
  };
  const endResize = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setWidth(useThreadPanelStore.getState().width, true);
  };
  const onResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const deltas: Record<string, number> = {
      ArrowLeft: KEYBOARD_RESIZE_STEP,
      ArrowRight: -KEYBOARD_RESIZE_STEP,
    };
    let next: number | null = null;
    if (event.key in deltas) next = width + deltas[event.key]!;
    if (event.key === "Home") next = THREAD_PANEL_MIN_WIDTH;
    if (event.key === "End") next = THREAD_PANEL_MAX_WIDTH;
    if (next === null) return;
    event.preventDefault();
    setWidth(clampThreadPanelWidth(next, containerWidth()), true);
  };
  const renderedWidth = clampThreadPanelWidth(width, containerWidth());

  // -- Escape closes the thread (unless a menu or the composer's menu owns it).
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector("[role=menu], [role=dialog], [role=listbox]")) return;
      const panel = panelRef.current;
      const target = event.target as Node | null;
      // Escape from the conversation's own composer keeps the panel.
      if (panel && target && !panel.contains(target) && target !== document.body) return;
      closeThread();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeThread]);

  // -- Scrolling: open at the bottom (or at the linked reply), follow new replies.
  const replyKey = thread.replies.map((reply) => reply.id).join(",");
  const initializedRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || thread.loading || !thread.root) return;
    const scope = `${conversationId}:${rootMessageId}:${highlightMessageId ?? ""}`;
    if (initializedRef.current !== scope) {
      initializedRef.current = scope;
      const target = highlightMessageId
        ? scroller.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(highlightMessageId)}"]`)
        : null;
      if (target) target.scrollIntoView({ block: "center" });
      else scroller.scrollTop = scroller.scrollHeight;
      return;
    }
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160;
    if (nearBottom) scroller.scrollTop = scroller.scrollHeight;
  }, [conversationId, highlightMessageId, replyKey, rootMessageId, thread.loading, thread.root]);

  // -- Read state: what the panel shows is read (while the page is visible).
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const onChange = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  const unreadThreadIds = useActivityStore((state) => state.threads);
  const hasUnread = (unreadThreadIds ?? []).some((item) => item.rootMessageId === rootMessageId);
  useEffect(() => {
    if (!pageVisible || !hasUnread || thread.loading) return;
    const ids = thread.replies
      .map((reply) => reply.id)
      .filter((id) => !id.startsWith("optimistic:"));
    if (ids.length === 0) return;
    void markConversationRead(conversationId, ids).catch(() => {});
  }, [conversationId, hasUnread, markConversationRead, pageVisible, replyKey, thread.loading, thread.replies]);

  // -- Mentions: highlight mentions of the signed-in user, like the timeline.
  const { mentionNames, mentionsYou } = useMentionNames(mentions);

  const handleSend = useCallback(
    (content: MessageInput, _images?: unknown, attachmentIds?: string[]): Promise<InputSendResult> =>
      thread.sendReply(content, attachmentIds ?? [], alsoSend).then((accepted) => {
        if (accepted) setAlsoSend(false);
        return accepted;
      }),
    [alsoSend, thread],
  );

  const destination = conversationType === "group" ? `#${conversationName}` : conversationName;
  const replyCount = thread.root?.thread?.replyCount ?? thread.replies.length;
  const draftKey = composerDraftKey.replyThread(user?.id, conversationId, rootMessageId);

  return (
    <aside
      ref={panelRef}
      data-testid="thread-panel"
      aria-label="Thread"
      className="thread-panel relative flex min-h-0 shrink-0 flex-col border-l border-border bg-surface"
      style={{ width: renderedWidth }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize thread panel"
        aria-valuemin={THREAD_PANEL_MIN_WIDTH}
        aria-valuemax={THREAD_PANEL_MAX_WIDTH}
        aria-valuenow={renderedWidth}
        tabIndex={0}
        data-testid="thread-panel-resize"
        data-dragging={dragging ? "true" : undefined}
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onKeyDown={onResizeKeyDown}
        onDoubleClick={() => setWidth(clampThreadPanelWidth(420, containerWidth()), true)}
        className="thread-panel-resize group/resize absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none outline-none"
      >
        <span
          aria-hidden="true"
          className={`absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2 transition-colors duration-150 ${
            dragging ? "bg-accent" : "bg-transparent group-hover/resize:bg-accent/60 group-focus-visible/resize:bg-accent"
          }`}
        />
      </div>
      {dragging && <div className="fixed inset-0 z-10 cursor-col-resize" aria-hidden="true" />}

      <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="text-[1rem] font-semibold text-text">Thread</h2>
          <div className="flex min-w-0 items-center gap-1 text-[0.786rem] text-text-dimmed">
            {conversationType === "group" && <Hash size={12} aria-hidden="true" className="shrink-0" />}
            <span className="truncate">{conversationName}</span>
          </div>
        </div>
        {thread.root && (
          <button
            type="button"
            className={buttonClass(thread.following ? "ghost" : "secondary", "sm")}
            onClick={() => void thread.setFollowing(!thread.following)}
            disabled={thread.followPending}
            aria-pressed={thread.following}
            data-testid="thread-follow-toggle"
            title={
              thread.following
                ? "Stop getting notified about new replies"
                : "Get notified about new replies"
            }
          >
            {thread.following ? <BellOff size={14} aria-hidden="true" /> : <Bell size={14} aria-hidden="true" />}
            {thread.following ? "Unfollow" : "Follow"}
          </button>
        )}
        <button
          type="button"
          className={iconButtonClass("md")}
          onClick={closeThread}
          aria-label="Close thread"
          title="Close thread (Esc)"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>

      <div ref={scrollRef} data-testid="thread-panel-scroll" className="min-h-0 flex-1 overflow-y-auto pb-3">
        {thread.loading && (
          <div className="px-5 py-8 text-center text-[0.929rem] text-text-dimmed">Loading thread...</div>
        )}
        {thread.error && (
          <div role="alert" className="mx-4 mt-4 rounded-lg border border-error-msg-border bg-error-msg-bg px-3 py-2 text-[0.857rem] text-error-bright">
            {thread.error}
          </div>
        )}
        {thread.root && (
          <>
            <div data-testid="thread-root" className="border-l-[3px] border-transparent pt-1">
              <SharedChatMessage
                message={thread.root}
                merged={false}
                mentionsYou={mentionsYou(thread.root)}
                onSetReaction={thread.setReaction}
                hideThreadActions
              >
                {thread.root.content && <Markdown content={thread.root.content} message={thread.root} mentions={mentionNames} />}
              </SharedChatMessage>
            </div>
            <div className="flex items-center gap-3 px-5 py-2" role="separator" aria-label={`${replyCount} replies`}>
              <span className="shrink-0 text-[0.786rem] font-medium text-text-dimmed">
                {replyCount === 0 ? "No replies yet" : `${replyCount} ${replyCount === 1 ? "reply" : "replies"}`}
              </span>
              <span className="h-px flex-1 bg-border" />
            </div>
            {thread.hasOlder && (
              <div className="flex justify-center px-5 pb-2">
                <button
                  type="button"
                  className={buttonClass("secondary", "sm")}
                  onClick={thread.loadOlder}
                  disabled={thread.loadingOlder}
                >
                  {thread.loadingOlder ? "Loading earlier replies..." : "Load earlier replies"}
                </button>
              </div>
            )}
            <div data-testid="thread-replies">
              {thread.replies.map((reply, index) => (
                <div
                  key={reply.id}
                  className={
                    reply.id === highlightMessageId
                      ? "border-l-[3px] border-accent bg-accent/[0.12]"
                      : "border-l-[3px] border-transparent"
                  }
                >
                  <SharedChatMessage
                    message={reply}
                    merged={shouldMergeChatMessage(thread.replies[index - 1], reply)}
                    mentionsYou={mentionsYou(reply)}
                    onSetReaction={reply.id.startsWith("optimistic:") ? undefined : thread.setReaction}
                    hideThreadActions
                  >
                    {reply.alsoSentToConversation && (
                      <div className="mb-0.5 text-[0.786rem] text-text-dimmed">Also sent to {destination}</div>
                    )}
                    {reply.content && <Markdown content={reply.content} message={reply} mentions={mentionNames} />}
                  </SharedChatMessage>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <MessageSendError error={thread.sendError} />
      {thread.root && (
        <div className="thread-panel-composer shrink-0">
          <InputBar
            convId={undefined}
            draftKey={draftKey}
            optimisticSend
            onSend={handleSend}
            onStop={() => {}}
            mentions={mentions}
            placeholder="Reply..."
            ariaLabel="Reply in thread"
            autoFocusKey={focusNonce > 0 ? `${rootMessageId}:${focusNonce}` : undefined}
            sharedUpload={isAuthenticated(token) ? { conversationId, token } : undefined}
            footer={
              <label className="flex min-w-0 cursor-pointer select-none items-center gap-1.5 text-[0.786rem] text-text-muted">
                <input
                  type="checkbox"
                  className="size-3.5 shrink-0 cursor-pointer accent-accent"
                  checked={alsoSend}
                  onChange={(event) => setAlsoSend(event.target.checked)}
                  data-testid="thread-also-send"
                />
                <span className="truncate">Also send to {destination}</span>
              </label>
            }
          />
        </div>
      )}
    </aside>
  );
}
