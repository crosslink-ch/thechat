import { useRef, useEffect, useCallback, useMemo, useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";
import { InputBar, type InputSendResult } from "./InputBar";
import { Markdown } from "./Markdown";
import { useAutoScroll } from "../hooks/useAutoScroll";
import { useMessageTopCommand } from "../hooks/useMessageTopCommand";
import { useOlderHistoryScroll } from "../hooks/useOlderHistoryScroll";
import { useScrollStability } from "../hooks/useScrollStability";
import type {
  BotInvocationProgressEventPublic,
  ChatMessage,
} from "@thechat/shared";
import type { ActiveHermesInvocationProgress } from "../lib/hermes-progress";
import type { MentionUser } from "./MentionList";
import { HermesProgressInline } from "./HermesProgressInline";
import type { HermesSlashCommand } from "../lib/hermes-slash-commands";
import { MessageSendError } from "./MessageSendError";
import {
  SharedChatMessage,
  shouldMergeChatMessage,
} from "./SharedChatMessage";

const DEFER_FORMATTING_MESSAGE_THRESHOLD = 40;
const DEFER_FORMATTING_BATCH_SIZE = 4;
const DEFER_FORMATTING_BATCH_DELAY_MS = 24;
const DEFER_FORMATTING_MAX_DELAY_MS = 900;

interface HermesDmChatViewProps {
  messages: ChatMessage[];
  loading: boolean;
  loadingOlder?: boolean;
  hasOlderMessages?: boolean;
  sendError?: string | null;
  typingUsers: Map<string, string>;
  progressInvocations: ActiveHermesInvocationProgress[];
  typingSuppressedUserIds: string[];
  onSend: (
    content: string,
    attachmentIds?: string[],
  ) => InputSendResult | Promise<InputSendResult>;
  onInteraction?: (
    event: BotInvocationProgressEventPublic,
    response: string | string[],
  ) => void | Promise<void>;
  onStop?: () => void;
  onLoadOlderMessages?: () => boolean | void | Promise<boolean | void>;
  onSetReaction?: (
    messageId: string,
    emoji: string,
    active: boolean,
  ) => void | Promise<void>;
  mentions?: MentionUser[];
  scrollKey?: string | null;
  draftKey?: string;
  taskActive?: boolean;
  queuedCount?: number;
  slashCommands?: HermesSlashCommand[];
  conversationId?: string;
  token?: string | null;
  composerKey?: string | number;
}

export function HermesDmChatView({
  messages,
  loading,
  loadingOlder = false,
  hasOlderMessages = false,
  sendError,
  typingUsers,
  progressInvocations,
  typingSuppressedUserIds,
  onSend,
  onInteraction,
  onStop,
  onLoadOlderMessages,
  onSetReaction,
  mentions,
  scrollKey,
  draftKey,
  taskActive = false,
  queuedCount = 0,
  slashCommands,
  conversationId,
  token,
  composerKey,
}: HermesDmChatViewProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const { isAtBottom, pauseAutoScroll, scrollToBottom, shouldFollowBottom } =
    useAutoScroll(scrollContainerRef);
  useMessageTopCommand(
    scrollContainerRef,
    messages.length > 0,
    pauseAutoScroll,
  );
  const isAtBottomRef = useRef(isAtBottom);
  const forceNextContentScrollRef = useRef(false);
  const initializedScrollKeyRef = useRef<string | null>(null);
  const progressScrollFrameRef = useRef<number | null>(null);
  const deferredFormattedIdsRef = useRef<Set<string>>(new Set());
  const deferredFormattingScopeRef = useRef<string | null>(null);
  const deferredFormattingPendingIdsRef = useRef<Set<string>>(new Set());
  const deferredFormattingTotalRef = useRef(0);
  const deferredFormattingFrameRef = useRef<number | null>(null);
  const [formattingProgress, setFormattingProgress] = useState({
    ready: 0,
    total: 0,
  });
  const [eagerFormatting, setEagerFormatting] = useState<{
    scopeKey: string | null;
    messageIds: Set<string>;
  }>({ scopeKey: null, messageIds: new Set() });

  const visibleTypingNames = useMemo(() => {
    const progressBotUserIds = new Set([
      ...progressInvocations.map(({ invocation }) => invocation.botUserId),
      ...typingSuppressedUserIds,
    ]);
    return Array.from(typingUsers.entries())
      .filter(([userId]) => !progressBotUserIds.has(userId))
      .map(([, userName]) => userName)
      .filter(Boolean);
  }, [progressInvocations, typingSuppressedUserIds, typingUsers]);
  const hasLiveActivity =
    progressInvocations.length > 0 || visibleTypingNames.length > 0;

  const messageScrollSignature = useMemo(
    () => chatMessageWindowSignature(messages),
    [messages],
  );
  const progressScrollSignature = useMemo(
    () =>
      [
        ...progressInvocations.map((invocation) => {
          const lastEvent = invocation.events[invocation.events.length - 1];
          return [
            invocation.invocation.id,
            invocation.invocation.status,
            invocation.invocation.updatedAt,
            invocation.invocation.threadId ?? "",
            invocation.events.length,
            lastEvent?.id ?? "",
            lastEvent?.sequence ?? "",
            lastEvent?.occurredAt ?? "",
          ].join(":");
        }),
        ...typingSuppressedUserIds,
      ].join("|"),
    [progressInvocations, typingSuppressedUserIds],
  );
  const typingScrollSignature = useMemo(
    () => visibleTypingNames.join("|"),
    [visibleTypingNames],
  );
  const scrollScopeKey = scrollKey ?? "__hermes_dm_chat_default__";
  const eagerlyFormattedMessageIds =
    eagerFormatting.scopeKey === scrollScopeKey
      ? eagerFormatting.messageIds
      : undefined;
  const deferMessageFormatting =
    messages.length > DEFER_FORMATTING_MESSAGE_THRESHOLD;
  const formattingHistory =
    deferMessageFormatting && formattingProgress.ready < formattingProgress.total;

  useEffect(() => {
    isAtBottomRef.current = isAtBottom;
  }, [isAtBottom]);

  useEffect(() => {
    if (deferredFormattingScopeRef.current !== scrollScopeKey) {
      deferredFormattingScopeRef.current = scrollScopeKey;
      deferredFormattedIdsRef.current = new Set();
    }

    const allMessageIds = new Set(messages.map((message) => message.id));
    const formattedIds = new Set(
      [...deferredFormattedIdsRef.current].filter((messageId) =>
        allMessageIds.has(messageId),
      ),
    );

    if (!deferMessageFormatting) {
      deferredFormattedIdsRef.current = allMessageIds;
      deferredFormattingPendingIdsRef.current = new Set();
      deferredFormattingTotalRef.current = allMessageIds.size;
      setFormattingProgress({
        ready: allMessageIds.size,
        total: allMessageIds.size,
      });
      return;
    }

    deferredFormattedIdsRef.current = formattedIds;
    const pendingIds = new Set(
      [...allMessageIds].filter((messageId) => !formattedIds.has(messageId)),
    );
    deferredFormattingPendingIdsRef.current = pendingIds;
    deferredFormattingTotalRef.current = allMessageIds.size;
    setFormattingProgress({
      ready: allMessageIds.size - pendingIds.size,
      total: allMessageIds.size,
    });
  }, [deferMessageFormatting, messageScrollSignature, messages, scrollScopeKey]);

  useEffect(() => {
    return () => {
      if (deferredFormattingFrameRef.current !== null) {
        cancelAnimationFrame(deferredFormattingFrameRef.current);
        deferredFormattingFrameRef.current = null;
      }
    };
  }, []);

  const handleDeferredMarkdownRender = useCallback(
    (messageId: string) => {
      deferredFormattedIdsRef.current.add(messageId);
      if (!deferredFormattingPendingIdsRef.current.delete(messageId)) return;

      if (deferredFormattingFrameRef.current !== null) return;
      deferredFormattingFrameRef.current = requestAnimationFrame(() => {
        deferredFormattingFrameRef.current = null;
        const total = deferredFormattingTotalRef.current;
        const ready = Math.max(
          0,
          total - deferredFormattingPendingIdsRef.current.size,
        );
        setFormattingProgress({ ready, total });
        if (isAtBottomRef.current) {
          scrollToBottom({ force: true });
        }
      });
    },
    [scrollToBottom],
  );

  const { requestOlderMessages, consumeSkipContentScroll } = useOlderHistoryScroll({
    containerRef: scrollContainerRef,
    loading,
    loadingOlder,
    hasOlderMessages,
    onLoadOlderMessages,
    messageScrollSignature,
  });
  useScrollStability(scrollContainerRef, shouldFollowBottom);

  useLayoutEffect(() => {
    if (loading || initializedScrollKeyRef.current === scrollScopeKey) return;
    initializedScrollKeyRef.current = scrollScopeKey;
    scrollToBottom({ force: true });
  }, [loading, scrollScopeKey, scrollToBottom]);

  useLayoutEffect(() => {
    if (forceNextContentScrollRef.current) {
      forceNextContentScrollRef.current = false;
      scrollToBottom({ force: true });
      return;
    }
    if (consumeSkipContentScroll()) return;
    scrollToBottom();
  }, [consumeSkipContentScroll, messageScrollSignature, scrollToBottom]);

  const promoteVisibleMessages = useCallback(() => {
    if (loading || !deferMessageFormatting) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    if (deferredFormattingScopeRef.current !== scrollScopeKey) {
      deferredFormattingScopeRef.current = scrollScopeKey;
      deferredFormattedIdsRef.current = new Set();
    }
    const containerBounds = container.getBoundingClientRect();
    const visibleMessageIds = new Set<string>();
    for (const row of container.querySelectorAll<HTMLElement>("[data-message-id]")) {
      const messageId = row.dataset.messageId;
      if (!messageId || deferredFormattedIdsRef.current.has(messageId)) continue;
      const bounds = row.getBoundingClientRect();
      if (
        bounds.bottom > containerBounds.top &&
        bounds.top < containerBounds.bottom
      ) {
        visibleMessageIds.add(messageId);
      }
    }
    if (visibleMessageIds.size === 0) return;

    for (const messageId of visibleMessageIds) {
      deferredFormattedIdsRef.current.add(messageId);
      deferredFormattingPendingIdsRef.current.delete(messageId);
    }
    setEagerFormatting((current) => {
      const messageIds =
        current.scopeKey === scrollScopeKey
          ? new Set(current.messageIds)
          : new Set<string>();
      const previousSize = messageIds.size;
      for (const messageId of visibleMessageIds) messageIds.add(messageId);
      if (
        current.scopeKey === scrollScopeKey &&
        messageIds.size === previousSize
      ) {
        return current;
      }
      return { scopeKey: scrollScopeKey, messageIds };
    });
  }, [deferMessageFormatting, loading, scrollScopeKey]);

  // Large histories still format offscreen rows in idle batches, but rows in
  // the opened viewport render final Markdown before the browser paints.
  useLayoutEffect(() => {
    promoteVisibleMessages();
  }, [messageScrollSignature, promoteVisibleMessages]);

  // Register after useAutoScroll's listener so a manual upward scroll records
  // its intent before synchronous formatting changes the scroll metrics.
  useEffect(() => {
    if (loading || !deferMessageFormatting) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    const handleScroll = () => flushSync(promoteVisibleMessages);
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [deferMessageFormatting, loading, promoteVisibleMessages]);

  useEffect(() => {
    if (progressScrollFrameRef.current !== null) {
      cancelAnimationFrame(progressScrollFrameRef.current);
    }
    progressScrollFrameRef.current = requestAnimationFrame(() => {
      progressScrollFrameRef.current = null;
      scrollToBottom();
    });

    return () => {
      if (progressScrollFrameRef.current !== null) {
        cancelAnimationFrame(progressScrollFrameRef.current);
        progressScrollFrameRef.current = null;
      }
    };
  }, [progressScrollSignature, scrollToBottom]);

  useEffect(() => {
    scrollToBottom();
  }, [typingScrollSignature, scrollToBottom]);

  const handleSend = useCallback(
    async (content: string, attachmentIds: string[] = []) => {
      forceNextContentScrollRef.current = true;
      const accepted = await (attachmentIds.length > 0
        ? onSend(content, attachmentIds)
        : onSend(content));
      requestAnimationFrame(() => scrollToBottom({ force: true }));
      return accepted !== false;
    },
    [onSend, scrollToBottom],
  );
  const shouldDeferFormatting = (messageId: string) =>
    deferMessageFormatting && !eagerlyFormattedMessageIds?.has(messageId);

  return (
    <>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollContainerRef}
          data-testid="hermes-dm-chat-scroll"
          className="flex flex-1 flex-col overflow-y-auto [overflow-anchor:none]"
        >
          {loading && (
            <div className="flex flex-1 flex-col items-center justify-center text-[1rem] text-text-placeholder">Loading messages...</div>
          )}
          {!loading && hasOlderMessages && (
            <div className="flex justify-center px-5 py-2">
              <button
                type="button"
                onClick={requestOlderMessages}
                disabled={loadingOlder}
                className="rounded border border-border bg-elevated px-3 py-1 text-[0.786rem] text-text-muted hover:bg-raised disabled:cursor-default disabled:opacity-60"
              >
                {loadingOlder ? "Loading earlier messages..." : "Load earlier messages"}
              </button>
            </div>
          )}
          {!loading && messages.length === 0 && (
            <div className="flex flex-1 flex-col items-center justify-center text-[1rem] text-text-placeholder">No messages yet. Start the conversation!</div>
          )}
          {messages.map((msg, index) => (
            <SharedChatMessage
              key={msg.id}
              message={msg}
              merged={
                shouldMergeChatMessage(messages[index - 1], msg) &&
                !hasInterveningHermesEvent(
                  messages[index - 1],
                  msg,
                  progressInvocations,
                )
              }
              onSetReaction={onSetReaction}
            >
              {msg.content && (
                <Markdown
                  content={msg.content}
                  defer={shouldDeferFormatting(msg.id)}
                  deferDelayMs={
                    shouldDeferFormatting(msg.id)
                      ? deferredMarkdownDelayMs(messages.length, index)
                      : 0
                  }
                  onDeferredRender={
                    shouldDeferFormatting(msg.id)
                      ? () => handleDeferredMarkdownRender(msg.id)
                      : undefined
                  }
                />
              )}
            </SharedChatMessage>
          ))}
          <HermesProgressInline
            invocations={progressInvocations}
            onInteraction={onInteraction}
            onStop={onStop}
          />
          {visibleTypingNames.length > 0 && (
            <div className="animate-pulse px-5 py-1 pb-2 text-[0.786rem] text-text-dimmed">
              {visibleTypingNames.join(", ")} {visibleTypingNames.length === 1 ? "is" : "are"} typing...
            </div>
          )}
        </div>
        {!loading && formattingHistory && (
          <div
            role="status"
            aria-live="polite"
            className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center px-5 py-1 text-[0.786rem] text-text-dimmed"
          >
            <span className="rounded border border-border bg-surface/95 px-2.5 py-1 shadow-sm">
              Formatting message history...
            </span>
          </div>
        )}
        {!isAtBottom && hasLiveActivity && (
          <button
            type="button"
            onClick={() => scrollToBottom({ force: true })}
            className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-elevated/90 px-3 py-1.5 text-xs shadow-md"
          >
            ↓ Jump to bottom
          </button>
        )}
      </div>
      <MessageSendError error={sendError} />
      <InputBar
        key={composerKey}
        convId={undefined}
        draftKey={
          draftKey ??
          `dm:${conversationId ?? scrollScopeKey}:composer:${String(
            composerKey ?? "stable",
          )}`
        }
        onSend={(content, _images, attachmentIds) =>
          handleSend(content, attachmentIds)
        }
        onStop={onStop ?? (() => {})}
        mentions={mentions}
        isStreamingOverride={taskActive}
        queuedCount={queuedCount}
        slashCommands={slashCommands}
        sharedUpload={
          conversationId && token ? { conversationId, token } : undefined
        }
      />
    </>
  );
}

function hasInterveningHermesEvent(
  previous: ChatMessage | undefined,
  current: ChatMessage,
  progressInvocations: ActiveHermesInvocationProgress[],
) {
  if (!previous) return false;
  // Active Hermes lanes are replaced when a human follow-up starts its
  // invocation. They must not make that optimistic row's grouping transient.
  if (current.senderType === "human") return false;

  const previousTime = new Date(previous.createdAt).getTime();
  const currentTime = new Date(current.createdAt).getTime();
  if (!Number.isFinite(previousTime) || !Number.isFinite(currentTime)) {
    return false;
  }

  const isBetweenMessages = (iso: string) => {
    const timestamp = new Date(iso).getTime();
    return (
      Number.isFinite(timestamp) &&
      timestamp > previousTime &&
      timestamp < currentTime
    );
  };

  return progressInvocations.some(({ invocation, events }) => {
    if (
      invocation.conversationId !== current.conversationId ||
      invocation.threadId !== current.threadId
    ) {
      return false;
    }

    if (isBetweenMessages(invocation.startedAt ?? invocation.createdAt)) {
      return true;
    }

    return events.some((event) => {
      if (
        event.conversationId !== current.conversationId ||
        event.threadId !== current.threadId
      ) {
        return false;
      }
      return isBetweenMessages(event.occurredAt);
    });
  });
}

function chatMessageWindowSignature(messages: ChatMessage[]) {
  const firstMessage = messages[0];
  const lastMessage = messages[messages.length - 1];
  return [
    messages.length,
    firstMessage?.id ?? "",
    firstMessage?.createdAt ?? "",
    firstMessage?.content.length ?? 0,
    lastMessage?.id ?? "",
    lastMessage?.createdAt ?? "",
    lastMessage?.content.length ?? 0,
  ].join(":");
}

function deferredMarkdownDelayMs(messageCount: number, index: number) {
  const distanceFromEnd = messageCount - index - 1;
  return Math.min(
    DEFER_FORMATTING_MAX_DELAY_MS,
    Math.floor(distanceFromEnd / DEFER_FORMATTING_BATCH_SIZE) *
      DEFER_FORMATTING_BATCH_DELAY_MS,
  );
}
