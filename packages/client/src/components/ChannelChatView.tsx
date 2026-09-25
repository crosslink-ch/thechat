import { isAuthenticated } from "../lib/auth-identity";
import { useAuthStore } from "../stores/auth";
import { mentionsName, type MentionNames } from "../lib/remark-mentions";
import { useRef, useEffect, useCallback, useMemo, useLayoutEffect } from "react";
import { InputBar, type InputSendResult } from "./InputBar";
import { Markdown } from "./Markdown";
import { useAutoScroll } from "../hooks/useAutoScroll";
import { useMessageTopCommand } from "../hooks/useMessageTopCommand";
import { useOlderHistoryScroll } from "../hooks/useOlderHistoryScroll";
import { useScrollStability } from "../hooks/useScrollStability";
import { MessageSendError } from "./MessageSendError";
import { HermesWorkLog } from "./HermesWorkLog";
import { foldHermesKeepAlives } from "../lib/hermes-keepalive";
import { ArrowDown } from "lucide-react";
import { buttonClass } from "./ui";
import type { ChatMessage } from "@thechat/shared";
import type { MentionUser } from "./MentionList";
import {
  SharedChatMessage,
  shouldMergeChatMessage,
} from "./SharedChatMessage";

const noop = () => {};

interface ChannelChatViewProps {
  messages: ChatMessage[];
  loading: boolean;
  loadingOlder?: boolean;
  hasOlderMessages?: boolean;
  sendError?: string | null;
  typingUsers: Map<string, string>; // userId -> userName
  onSend: (
    content: string,
    attachmentIds?: string[],
  ) => InputSendResult | Promise<InputSendResult>;
  onLoadOlderMessages?: () => boolean | void | Promise<boolean | void>;
  onSetReaction?: (
    messageId: string,
    emoji: string,
    active: boolean,
  ) => void | Promise<void>;
  mentions?: MentionUser[];
  scrollKey?: string | null;
  draftKey?: string;
  conversationId?: string;
  token?: string | null;
}

export function ChannelChatView({
  messages: incomingMessages,
  loading,
  loadingOlder = false,
  hasOlderMessages = false,
  sendError,
  typingUsers,
  onSend,
  onLoadOlderMessages,
  onSetReaction,
  mentions,
  scrollKey,
  draftKey,
  conversationId,
  token,
}: ChannelChatViewProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const { isAtBottom, pauseAutoScroll, scrollToBottom, shouldFollowBottom } =
    useAutoScroll(scrollContainerRef);
  useMessageTopCommand(
    scrollContainerRef,
    incomingMessages.length > 0,
    pauseAutoScroll,
  );
  const forceNextContentScrollRef = useRef(false);
  const initializedScrollKeyRef = useRef<string | null>(null);

  const visibleTypingNames = useMemo(
    () => Array.from(typingUsers.values()).filter(Boolean),
    [typingUsers],
  );
  const hasLiveActivity = visibleTypingNames.length > 0;

  // Workspace names shown as @mention pills; mentions of you are highlighted.
  const selfId = useAuthStore((state) => state.user?.id ?? null);
  const selfName = useAuthStore((state) => state.user?.name ?? null);
  const mentionNames = useMemo<MentionNames>(
    () => ({ names: (mentions ?? []).map((mention) => mention.label), self: selfName }),
    [mentions, selfName],
  );
  const mentionsYou = (message: { senderId: string; content: string }) =>
    message.senderId !== selfId && mentionsName(message.content, selfName);
  // Hermes keep-alive updates fold into the answer they precede.
  const foldedMessages = useMemo(
    () => foldHermesKeepAlives(incomingMessages),
    [incomingMessages],
  );
  const messageScrollSignature = useMemo(
    () => chatMessageWindowSignature(incomingMessages),
    [incomingMessages],
  );
  const typingScrollSignature = useMemo(
    () => visibleTypingNames.join("|"),
    [visibleTypingNames],
  );
  const scrollScopeKey = scrollKey ?? "__channel_chat_default__";

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

  useEffect(() => {
    scrollToBottom();
  }, [typingScrollSignature, scrollToBottom]);

  const handleSend = useCallback(
    (content: string, attachmentIds: string[] = []) => {
      forceNextContentScrollRef.current = true;
      const result =
        attachmentIds.length > 0
          ? onSend(content, attachmentIds)
          : onSend(content);
      requestAnimationFrame(() => scrollToBottom({ force: true }));
      return result;
    },
    [onSend, scrollToBottom],
  );

  return (
    <>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollContainerRef}
          data-testid="channel-chat-scroll"
          className="flex flex-1 flex-col overflow-y-auto [overflow-anchor:none]"
        >
          {loading && (
            <div className="flex flex-1 flex-col items-center justify-center text-[1rem] text-text-dimmed">Loading messages...</div>
          )}
          {!loading && hasOlderMessages && (
            <div className="flex justify-center px-5 py-3">
              <button
                type="button"
                onClick={requestOlderMessages}
                disabled={loadingOlder}
                className={buttonClass("secondary", "sm")}
              >
                {loadingOlder ? "Loading earlier messages..." : "Load earlier messages"}
              </button>
            </div>
          )}
          {!loading && incomingMessages.length === 0 && (
            <div className="flex flex-1 flex-col items-center justify-center text-[1rem] text-text-dimmed">No messages yet. Start the conversation!</div>
          )}
          {foldedMessages.map((item, index) =>
            item.kind === "working" ? (
              <SharedChatMessage
                key={item.message.id}
                message={{ ...item.message, content: "" }}
                merged={false}
              >
                <HermesWorkLog run={item.run} live />
              </SharedChatMessage>
            ) : (
              <SharedChatMessage
                key={item.message.id}
                message={item.message}
                merged={shouldMergeChatMessage(
                  foldedMessages[index - 1]?.message,
                  item.message,
                )}
                mentionsYou={mentionsYou(item.message)}
                onSetReaction={onSetReaction}
              >
                {item.run && <HermesWorkLog run={item.run} />}
                {item.message.content && (
                  <Markdown content={item.message.content} mentions={mentionNames} />
                )}
              </SharedChatMessage>
            ),
          )}
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
            className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-surface/95 px-3 py-1.5 text-[0.857rem] font-medium text-text-secondary shadow-card backdrop-blur-xl transition-colors duration-150 hover:bg-elevated hover:text-text animate-fade-in"
          >
            <ArrowDown size={14} aria-hidden="true" />
            Jump to bottom
          </button>
        )}
      </div>
      <MessageSendError error={sendError} />
      <InputBar
        convId={undefined}
        draftKey={draftKey ?? `channel:${conversationId ?? scrollScopeKey}`}
        optimisticSend
        onSend={(content, _images, attachmentIds) =>
          handleSend(content, attachmentIds)
        }
        onStop={noop}
        mentions={mentions}
        sharedUpload={
          conversationId && isAuthenticated(token) ? { conversationId, token: token ?? null } : undefined
        }
      />
    </>
  );
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
