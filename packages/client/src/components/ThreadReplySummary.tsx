import type { MessageThreadSummary } from "@thechat/shared";
import { ChevronRight } from "lucide-react";
import { Avatar } from "./Avatar";
import { useBotAppearance } from "../lib/bot-appearance";
import { formatFullMessageTimestamp } from "../lib/message-timestamp";

/** "5m ago" style age of the newest reply. */
export function relativeReplyTime(iso: string, now = Date.now()) {
  const elapsed = now - new Date(iso).getTime();
  if (!Number.isFinite(elapsed)) return "";
  const minutes = Math.max(0, Math.floor(elapsed / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

function ParticipantAvatar({ participant }: { participant: MessageThreadSummary["participants"][number] }) {
  const botAvatar = useBotAppearance(participant.type === "bot" ? participant.id : null);
  return (
    <Avatar
      aria-hidden="true"
      name={participant.name}
      colorKey={participant.id}
      bot={participant.type === "bot"}
      botAvatar={botAvatar}
      size={20}
      className="size-5 text-[0.643rem] ring-2 ring-base"
    />
  );
}

/**
 * The row under a root message, like Slack's: who replied, how many replies
 * and when the latest one came in. Opens the thread in the side panel.
 */
export function ThreadReplySummary({
  summary,
  active = false,
  unread = false,
  onOpen,
}: {
  summary: MessageThreadSummary;
  active?: boolean;
  unread?: boolean;
  onOpen: () => void;
}) {
  const label = `${summary.replyCount} ${summary.replyCount === 1 ? "reply" : "replies"}`;
  return (
    <button
      type="button"
      data-thread-summary
      data-active={active ? "true" : undefined}
      onClick={onOpen}
      aria-label={`${label}, last reply ${relativeReplyTime(summary.lastReplyAt)}. View thread`}
      className={`group/thread mt-1 flex max-w-full cursor-pointer items-center gap-2 rounded-lg border px-1.5 py-1 text-left transition-colors duration-150 ${
        active
          ? "border-accent/40 bg-accent/10"
          : "border-transparent hover:border-border hover:bg-white/[0.04]"
      }`}
    >
      <span className="flex shrink-0 -space-x-1.5">
        {summary.participants.slice(0, 4).map((participant) => (
          <ParticipantAvatar key={participant.id} participant={participant} />
        ))}
      </span>
      <span className="shrink-0 text-[0.857rem] font-semibold text-accent group-hover/thread:underline">
        {label}
      </span>
      {unread && (
        <span
          data-thread-unread
          className="size-2 shrink-0 rounded-full bg-accent"
          aria-label="Unread replies"
        />
      )}
      <span
        className="min-w-0 truncate text-[0.786rem] text-text-dimmed"
        title={formatFullMessageTimestamp(summary.lastReplyAt)}
      >
        <span className="group-hover/thread:hidden">Last reply {relativeReplyTime(summary.lastReplyAt)}</span>
        <span className="hidden group-hover/thread:inline">View thread</span>
      </span>
      <ChevronRight
        size={14}
        aria-hidden="true"
        className="shrink-0 text-text-dimmed opacity-0 transition-opacity group-hover/thread:opacity-100"
      />
    </button>
  );
}
