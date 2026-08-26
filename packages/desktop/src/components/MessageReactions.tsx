import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { MessageReactionSummary } from "@thechat/shared";
import { useId, useState } from "react";

export const DEFAULT_REACTION_EMOJIS = [
  "👍",
  "❤️",
  "😂",
  "🎉",
  "😮",
  "😢",
  "🙏",
  "🔥",
] as const;

interface MessageReactionsProps {
  reactions: MessageReactionSummary[];
  onSetReaction: (emoji: string, active: boolean) => void | Promise<void>;
}

export function MessageReactions({
  reactions,
  onSetReaction,
}: MessageReactionsProps) {
  const [pendingEmoji, setPendingEmoji] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pickerLabelId = useId();
  const hasReactions = reactions.length > 0;
  const reservesSpace = hasReactions || error !== null;

  const updateReaction = async (emoji: string, active: boolean) => {
    if (pendingEmoji) return;
    setPendingEmoji(emoji);
    setError(null);
    try {
      await onSetReaction(emoji, active);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not update reaction",
      );
    } finally {
      setPendingEmoji(null);
    }
  };

  return (
    <div
      className={
        reservesSpace ? "mt-1 flex min-h-7 flex-wrap items-center gap-1" : "h-0"
      }
    >
      {reactions.map((reaction) => (
        <button
          key={reaction.emoji}
          type="button"
          className={`inline-flex h-7 items-center gap-1 rounded-full border px-2 text-[0.8rem] font-medium transition-colors disabled:cursor-wait disabled:opacity-60 ${
            reaction.reactedByMe
              ? "border-accent bg-[rgba(47,136,191,0.18)] text-text"
              : "border-border-subtle bg-raised text-text-muted hover:border-border hover:bg-hover hover:text-text"
          }`}
          aria-label={`${reaction.emoji} ${reaction.count} ${reaction.count === 1 ? "reaction" : "reactions"}`}
          aria-pressed={reaction.reactedByMe}
          title={`${formatNames(reaction.userNames)} reacted with ${reaction.emoji}`}
          disabled={pendingEmoji !== null}
          onClick={() => {
            void updateReaction(reaction.emoji, !reaction.reactedByMe);
          }}
        >
          <span className="text-[1rem] leading-none" aria-hidden="true">
            {reaction.emoji}
          </span>
          <span>{reaction.count}</span>
        </button>
      ))}

      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className={`inline-flex size-7 items-center justify-center rounded-full border border-border-subtle bg-transparent text-text-dimmed transition-colors hover:border-border hover:bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-wait disabled:opacity-50 ${
              hasReactions
                ? ""
                : "absolute right-3 top-2 opacity-0 group-hover/message:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
            }`}
            aria-label="Add reaction"
            title="Add reaction"
            disabled={pendingEmoji !== null}
          >
            <ReactionIcon />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            side="top"
            align={hasReactions ? "start" : "end"}
            sideOffset={6}
            collisionPadding={12}
            aria-labelledby={pickerLabelId}
            className="z-50 grid grid-cols-4 gap-1 rounded-xl border border-border bg-elevated p-2 shadow-2xl"
          >
            <DropdownMenu.Label id={pickerLabelId} className="sr-only">
              Choose a reaction
            </DropdownMenu.Label>
            {DEFAULT_REACTION_EMOJIS.map((emoji) => {
              const active = reactions.some(
                (reaction) =>
                  reaction.emoji === emoji && reaction.reactedByMe,
              );
              return (
                <DropdownMenu.Item
                  key={emoji}
                  asChild
                  onSelect={() => {
                    void updateReaction(emoji, !active);
                  }}
                >
                  <button
                    type="button"
                    className="flex size-9 items-center justify-center rounded-lg text-xl outline-none transition-transform hover:scale-110 hover:bg-hover focus:bg-hover data-[highlighted]:bg-hover"
                    aria-label={`${active ? "Remove" : "React with"} ${emoji}`}
                    title={`${active ? "Remove" : "React with"} ${emoji}`}
                  >
                    {emoji}
                  </button>
                </DropdownMenu.Item>
              );
            })}
            <DropdownMenu.Arrow className="fill-border" />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {error && (
        <span role="alert" className="basis-full text-[0.714rem] text-error-bright">
          {error}
        </span>
      )}
    </div>
  );
}

function formatNames(names: string[]) {
  if (names.length === 0) return "Someone";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

function ReactionIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7.5" />
      <path d="M8.2 9h.01M13.8 9h.01M8.1 13.1c.8 1.1 1.8 1.6 2.9 1.6 1.2 0 2.2-.5 3-1.6" />
      <path d="M19 14v6M16 17h6" />
    </svg>
  );
}
