import type { ChatMessage } from "@thechat/shared";
import type { ReactNode } from "react";
import { useProfilePicture } from "../hooks/useProfilePicture";
import { useBotAppearance } from "../lib/bot-appearance";
import { Avatar } from "./Avatar";
import { MessageReactions } from "./MessageReactions";
import { ThreadReplySummary } from "./ThreadReplySummary";
import { SharedMessageAttachments } from "./SharedMessageAttachments";
import {
  formatFullMessageTimestamp,
  formatMessageTimestamp,
  getValidMessageDateTime,
} from "../lib/message-timestamp";

export const MESSAGE_MERGE_WINDOW_MS = 5 * 60 * 1000;

export function shouldMergeChatMessage(
  previous: ChatMessage | undefined,
  current: ChatMessage,
) {
  if (
    !previous ||
    previous.senderId !== current.senderId ||
    previous.conversationId !== current.conversationId ||
    previous.threadId !== current.threadId ||
    // A root with replies, or a reply also sent here, keeps its own header.
    previous.thread ||
    current.alsoSentToConversation
  ) {
    return false;
  }

  const previousDate = new Date(previous.createdAt);
  const currentDate = new Date(current.createdAt);
  const elapsed = currentDate.getTime() - previousDate.getTime();
  // Optimistic messages use the client's clock while persisted messages use
  // the server's. Preserve their logical append order when those clocks make
  // a newly sent follow-up appear a little earlier than its predecessor.
  const optimisticClockSkew =
    current.id.startsWith("optimistic:") && elapsed < 0;
  const mergeElapsed = optimisticClockSkew ? 0 : elapsed;
  const mergeCurrentDate = optimisticClockSkew ? previousDate : currentDate;

  return (
    Number.isFinite(mergeElapsed) &&
    mergeElapsed >= 0 &&
    mergeElapsed <= MESSAGE_MERGE_WINDOW_MS &&
    previousDate.getFullYear() === mergeCurrentDate.getFullYear() &&
    previousDate.getMonth() === mergeCurrentDate.getMonth() &&
    previousDate.getDate() === mergeCurrentDate.getDate()
  );
}

interface SharedChatMessageProps {
  message: ChatMessage;
  merged: boolean;
  children: ReactNode;
  /** The message @mentions the signed-in user. */
  mentionsYou?: boolean;
  /** The message a search result jumped to: briefly marked. */
  highlighted?: boolean;
  onSetReaction?: (
    messageId: string,
    emoji: string,
    active: boolean,
  ) => void | Promise<void>;
  /**
   * Open this message's reply thread (Slack-style). Shows "Reply in thread"
   * and, when it has replies, the reply summary under the message.
   */
  onOpenThread?: (rootMessageId: string, options?: { focus?: boolean }) => void;
  /** This message's thread is open in the side panel. */
  threadOpen?: boolean;
  /** The thread has replies the signed-in user has not read. */
  threadUnread?: boolean;
  /** Hide reply affordances (e.g. the root inside its own thread panel). */
  hideThreadActions?: boolean;
}

export function SharedChatMessage({
  message,
  merged,
  children,
  mentionsYou = false,
  highlighted = false,
  onSetReaction,
  onOpenThread,
  threadOpen = false,
  threadUnread = false,
  hideThreadActions = false,
}: SharedChatMessageProps) {
  // Replies attach to the root, so a reply shown in the timeline (also sent
  // to the conversation) opens its root's thread.
  const threadRootId = message.parentMessageId ?? message.id;
  const canOpenThread =
    Boolean(onOpenThread) &&
    !hideThreadActions &&
    !message.id.startsWith("optimistic:") &&
    !message.interim;
  const botAvatar = useBotAppearance(
    message.senderType === "bot" ? message.senderId : null,
  );
  const picture = useProfilePicture(
    message.senderType === "bot" ? null : message.senderId,
  );
  // Grouped rows only have the avatar-width gutter for their hover time.
  // Their full date remains available through the tooltip and accessible label.
  const displayTime = merged
    ? formatTime(message.createdAt)
    : formatMessageTimestamp(message.createdAt);
  const fullTime = formatFullMessageTimestamp(message.createdAt);
  const dateTime = getValidMessageDateTime(message.createdAt);

  return (
    <div
      data-message-id={message.id}
      data-message-grouped={merged ? "true" : "false"}
      data-mentions-you={mentionsYou ? "true" : undefined}
      data-message-interim={message.interim ? "true" : undefined}
      data-message-highlighted={highlighted ? "true" : undefined}
      data-thread-open={threadOpen ? "true" : undefined}
      className={`group/message group relative flex gap-2.5 px-5 transition-colors duration-100 ${
        highlighted
          ? "bg-accent/[0.12] shadow-[inset_3px_0_0_var(--color-accent)]"
          : threadOpen
            ? "bg-accent/[0.06] hover:bg-white/[0.025]"
            : "hover:bg-white/[0.025]"
      } ${merged ? "py-0.5" : "pb-0.5 pt-2.5"} ${
        message.interim ? "text-text-muted opacity-75" : ""
      }`}
    >
      {merged ? (
        <time
          dateTime={dateTime}
          aria-label={`Sent ${fullTime}`}
          title={fullTime}
          tabIndex={0}
          className="mt-0.5 flex h-8 w-8 shrink-0 cursor-default items-center justify-center whitespace-nowrap text-[0.625rem] text-text-dimmed opacity-0 outline-none transition-opacity group-hover:opacity-100 focus:opacity-100 active:opacity-100 focus-visible:ring-1 focus-visible:ring-border-focus"
        >
          {displayTime}
        </time>
      ) : (
        <Avatar
          aria-hidden="true"
          name={message.senderName}
          colorKey={message.senderId}
          picture={picture}
          bot={message.senderType === "bot"}
          botAvatar={botAvatar}
          size={32}
          className="mt-0.5 size-8 text-[0.857rem]"
        />
      )}
      <div className="min-w-0 flex-1">
        {merged ? (
          <span className="sr-only">{message.senderName}, continued: </span>
        ) : (
          <div
            data-message-header="true"
            className="mb-0.5 flex items-baseline gap-2"
          >
            <span className="text-[0.929rem] font-semibold text-text">
              {message.senderName}
            </span>
            <time
              dateTime={dateTime}
              title={fullTime}
              className="text-[0.714rem] text-text-dimmed"
            >
              {displayTime}
            </time>
          </div>
        )}
        {message.alsoSentToConversation && message.parentMessageId && !hideThreadActions && (
          <div className="mb-0.5 text-[0.786rem] text-text-dimmed">
            replied to a thread
            {canOpenThread && (
              <>
                {": "}
                <button
                  type="button"
                  className="cursor-pointer border-none bg-transparent p-0 font-[inherit] text-accent hover:underline"
                  onClick={() => onOpenThread!(threadRootId)}
                >
                  View thread
                </button>
              </>
            )}
          </div>
        )}
        {children}
        <SharedMessageAttachments attachments={message.attachments ?? []} />
        {message.thread && !message.parentMessageId && onOpenThread && !hideThreadActions && (
          <ThreadReplySummary
            summary={message.thread}
            active={threadOpen}
            unread={threadUnread}
            onOpen={() => onOpenThread(message.id)}
          />
        )}
        {(onSetReaction || message.content || canOpenThread) && (
          <MessageReactions
            copyText={message.content}
            reactions={message.reactions ?? []}
            onSetReaction={onSetReaction ? (emoji, active) =>
              onSetReaction(message.id, emoji, active) : undefined
            }
            onReplyInThread={
              canOpenThread
                ? () => onOpenThread!(threadRootId, { focus: true })
                : undefined
            }
          />
        )}
      </div>
    </div>
  );
}

function formatTime(iso: string) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "Unknown time";
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}
