import { useRef, useEffect, useCallback, useMemo } from "react";
import { InputBar } from "./InputBar";
import { Markdown } from "./Markdown";
import { useAutoScroll } from "../hooks/useAutoScroll";
import type {
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
  ChatMessage,
} from "@thechat/shared";
import type { MentionUser } from "./MentionList";
import { HermesProgressInline } from "./HermesProgressInline";

const noop = () => {};
const EMPTY_PROGRESS_INVOCATIONS: BotInvocationPublic[] = [];
const EMPTY_PROGRESS_EVENTS: BotInvocationProgressEventPublic[] = [];
const EMPTY_TYPING_SUPPRESSED_USER_IDS: string[] = [];

interface ChannelChatViewProps {
  messages: ChatMessage[];
  loading: boolean;
  typingUsers: Map<string, string>; // userId -> userName
  progressInvocations?: BotInvocationPublic[];
  progressEvents?: BotInvocationProgressEventPublic[];
  typingSuppressedUserIds?: string[];
  onSend: (content: string) => void;
  mentions?: MentionUser[];
  scrollKey?: string | null;
}

function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ChannelChatView({
  messages,
  loading,
  typingUsers,
  progressInvocations = EMPTY_PROGRESS_INVOCATIONS,
  progressEvents = EMPTY_PROGRESS_EVENTS,
  typingSuppressedUserIds = EMPTY_TYPING_SUPPRESSED_USER_IDS,
  onSend,
  mentions,
  scrollKey,
}: ChannelChatViewProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const { isAtBottom, scrollToBottom } = useAutoScroll(scrollContainerRef);
  const forceNextContentScrollRef = useRef(false);
  const initializedScrollKeyRef = useRef<string | null>(null);

  const progressBotUserIds = new Set([
    ...progressInvocations.map((invocation) => invocation.botUserId),
    ...typingSuppressedUserIds,
  ]);
  const visibleTypingNames = Array.from(typingUsers.entries())
    .filter(([userId]) => !progressBotUserIds.has(userId))
    .map(([, userName]) => userName)
    .filter(Boolean);
  const hasLiveActivity =
    progressInvocations.length > 0 || visibleTypingNames.length > 0;

  const messageScrollSignature = useMemo(
    () =>
      messages
        .map((message) => `${message.id}:${message.createdAt}:${message.content.length}`)
        .join("|"),
    [messages],
  );
  const progressScrollSignature = useMemo(
    () =>
      [
        ...progressInvocations.map((invocation) =>
          [
            invocation.id,
            invocation.status,
            invocation.updatedAt,
            invocation.threadId ?? "",
          ].join(":"),
        ),
        ...progressEvents.map((event) =>
          [
            event.id,
            event.invocationId,
            event.sequence,
            event.status ?? "",
            event.label ?? "",
            event.preview ?? "",
            event.occurredAt,
          ].join(":"),
        ),
        ...typingSuppressedUserIds,
      ].join("|"),
    [progressEvents, progressInvocations, typingSuppressedUserIds],
  );
  const typingScrollSignature = useMemo(
    () => visibleTypingNames.join("|"),
    [visibleTypingNames],
  );
  const scrollScopeKey = scrollKey ?? "__channel_chat_default__";

  useEffect(() => {
    if (loading || initializedScrollKeyRef.current === scrollScopeKey) return;
    initializedScrollKeyRef.current = scrollScopeKey;
    scrollToBottom({ force: true });
  }, [loading, scrollScopeKey, scrollToBottom]);

  useEffect(() => {
    if (forceNextContentScrollRef.current) {
      forceNextContentScrollRef.current = false;
      scrollToBottom({ force: true });
      return;
    }
    scrollToBottom();
  }, [messageScrollSignature, scrollToBottom]);

  useEffect(() => {
    scrollToBottom();
  }, [progressScrollSignature, scrollToBottom]);

  useEffect(() => {
    scrollToBottom();
  }, [typingScrollSignature, scrollToBottom]);

  const handleSend = useCallback(
    (content: string) => {
      forceNextContentScrollRef.current = true;
      onSend(content);
      requestAnimationFrame(() => scrollToBottom({ force: true }));
    },
    [onSend, scrollToBottom],
  );

  return (
    <>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollContainerRef}
          data-testid="channel-chat-scroll"
          className="flex flex-1 flex-col overflow-y-auto"
        >
          {loading && (
            <div className="flex flex-1 flex-col items-center justify-center text-[1rem] text-text-placeholder">Loading messages...</div>
          )}
          {!loading && messages.length === 0 && (
            <div className="flex flex-1 flex-col items-center justify-center text-[1rem] text-text-placeholder">No messages yet. Start the conversation!</div>
          )}
          {messages.map((msg) => (
            <div key={msg.id} className="flex gap-2.5 px-5 py-2.5 transition-colors duration-100 hover:bg-raised/50">
              <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-elevated text-[0.857rem] font-semibold text-text-muted">
                {msg.senderName.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="mb-0.5 flex items-baseline gap-2">
                  <span className="text-[0.929rem] font-semibold text-text">{msg.senderName}</span>
                  <span className="text-[0.714rem] text-text-dimmed">{formatTime(msg.createdAt)}</span>
                </div>
                <Markdown content={msg.content} />
              </div>
            </div>
          ))}
          <HermesProgressInline
            invocations={progressInvocations}
            events={progressEvents}
          />
          {visibleTypingNames.length > 0 && (
            <div className="animate-pulse px-5 py-1 pb-2 text-[0.786rem] text-text-dimmed">
              {visibleTypingNames.join(", ")} {visibleTypingNames.length === 1 ? "is" : "are"} typing...
            </div>
          )}
        </div>
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
      <InputBar convId={undefined} onSend={handleSend} onStop={noop} mentions={mentions} />
    </>
  );
}
