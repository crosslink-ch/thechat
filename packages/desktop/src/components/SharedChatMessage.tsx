import type { ChatMessage } from "@thechat/shared";
import type { ReactNode } from "react";
import { MessageReactions } from "./MessageReactions";
import { SharedMessageAttachments } from "./SharedMessageAttachments";

export const MESSAGE_MERGE_WINDOW_MS = 5 * 60 * 1000;

export function shouldMergeChatMessage(
  previous: ChatMessage | undefined,
  current: ChatMessage,
) {
  if (
    !previous ||
    previous.senderId !== current.senderId ||
    previous.conversationId !== current.conversationId ||
    previous.threadId !== current.threadId
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
  onSetReaction?: (
    messageId: string,
    emoji: string,
    active: boolean,
  ) => void | Promise<void>;
}

export function SharedChatMessage({
  message,
  merged,
  children,
  onSetReaction,
}: SharedChatMessageProps) {
  const shortTime = formatTime(message.createdAt);
  const fullTime = formatFullTime(message.createdAt);

  return (
    <div
      data-message-id={message.id}
      data-message-grouped={merged ? "true" : "false"}
      className={`group/message group relative flex gap-2.5 px-5 transition-colors duration-100 hover:bg-raised/50 ${
        merged ? "py-0.5" : "pb-0.5 pt-2.5"
      }`}
    >
      {merged ? (
        <time
          dateTime={message.createdAt}
          aria-label={`Sent ${fullTime}`}
          title={fullTime}
          tabIndex={0}
          className="mt-0.5 flex h-8 w-8 shrink-0 cursor-default items-center justify-center whitespace-nowrap text-[0.625rem] text-text-dimmed opacity-0 outline-none transition-opacity group-hover:opacity-100 focus:opacity-100 active:opacity-100 focus-visible:ring-1 focus-visible:ring-border-focus"
        >
          {shortTime}
        </time>
      ) : (
        <div
          aria-hidden="true"
          className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-elevated text-[0.857rem] font-semibold text-text-muted"
        >
          {message.senderName.charAt(0).toUpperCase()}
        </div>
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
              dateTime={message.createdAt}
              title={fullTime}
              className="text-[0.714rem] text-text-dimmed"
            >
              {shortTime}
            </time>
          </div>
        )}
        {children}
        <SharedMessageAttachments attachments={message.attachments ?? []} />
        {onSetReaction && (
          <MessageReactions
            reactions={message.reactions ?? []}
            onSetReaction={(emoji, active) =>
              onSetReaction(message.id, emoji, active)
            }
          />
        )}
      </div>
    </div>
  );
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatFullTime(iso: string) {
  return new Date(iso).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}
