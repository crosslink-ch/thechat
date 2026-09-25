import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { MessageReactionSummary } from "@thechat/shared";
import { useId, useState } from "react";
import { SmilePlus } from "lucide-react";
import { EmojiImage } from "./EmojiImage";
import { CopyMessageButton } from "./CopyMessageButton";

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
  copyText?: string;
  reactions: MessageReactionSummary[];
  onSetReaction?: (emoji: string, active: boolean) => void | Promise<void>;
}

export function MessageReactions({
  copyText,
  reactions,
  onSetReaction,
}: MessageReactionsProps) {
  const [pendingEmoji, setPendingEmoji] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const pickerLabelId = useId();
  const hasReactions = reactions.length > 0;
  const reservesSpace = hasReactions || error !== null || copyError !== null;

  const updateReaction = async (emoji: string, active: boolean) => {
    if (pendingEmoji || !onSetReaction) return;
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
      data-message-reactions
      className={
        reservesSpace ? "mt-1 flex min-h-7 flex-wrap items-center gap-1" : "h-0"
      }
    >
      {reactions.map((reaction) => (
        <button
          key={reaction.emoji}
          type="button"
          className={`inline-flex h-7 cursor-pointer items-center gap-1 rounded-full border px-2 text-[0.857rem] font-medium tabular-nums transition-colors duration-150 disabled:cursor-wait disabled:opacity-60 ${
            reaction.reactedByMe
              ? "border-accent bg-accent/15 text-text hover:bg-accent/25"
              : "border-border bg-raised text-text-muted hover:border-border-strong hover:bg-hover hover:text-text"
          }`}
          aria-label={`${reaction.emoji} ${reaction.count} ${reaction.count === 1 ? "reaction" : "reactions"}`}
          aria-pressed={reaction.reactedByMe}
          title={`${formatNames(reaction.userNames)} reacted with ${reaction.emoji}`}
          disabled={pendingEmoji !== null || !onSetReaction}
          onClick={() => {
            void updateReaction(reaction.emoji, !reaction.reactedByMe);
          }}
        >
          <EmojiImage emoji={reaction.emoji} size={16} />
          <span>{reaction.count}</span>
        </button>
      ))}

      <div
        data-message-actions
        className={`inline-flex items-center gap-1 ${hasReactions ? "" : "absolute right-3 top-2 opacity-0 group-hover/message:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100"}`}
      >
        {onSetReaction && (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className="inline-flex size-7 cursor-pointer items-center justify-center rounded-full border border-border bg-transparent text-text-dimmed transition-colors duration-150 hover:border-border-strong hover:bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-wait disabled:opacity-50 data-[state=open]:border-border-strong data-[state=open]:bg-hover data-[state=open]:text-text"
                aria-label="Add reaction"
                title="Add reaction"
                disabled={pendingEmoji !== null}
              >
                <SmilePlus size={16} aria-hidden="true" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                side="top"
                align={hasReactions ? "start" : "end"}
                sideOffset={6}
                collisionPadding={12}
                aria-labelledby={pickerLabelId}
                // Frosted menu surface without the list min-width (a snug 4x2
                // grid) and without the scale-in motion, so touch targets
                // measure a full 44px as soon as the picker opens.
                className="z-50 grid grid-cols-4 gap-1 rounded-xl border border-border bg-surface/95 p-1.5 shadow-card backdrop-blur-2xl backdrop-saturate-150 animate-fade-in"
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
                        className={`flex size-9 cursor-pointer items-center justify-center rounded-lg border-none outline-none transition-[transform,background-color] duration-100 hover:scale-110 ${
                          active
                            ? "bg-accent/15 hover:bg-accent/25 focus:bg-accent/25 data-[highlighted]:bg-accent/25"
                            : "bg-transparent hover:bg-hover focus:bg-hover data-[highlighted]:bg-hover"
                        }`}
                        aria-label={`${active ? "Remove" : "React with"} ${emoji}`}
                        title={`${active ? "Remove" : "React with"} ${emoji}`}
                      >
                        <EmojiImage emoji={emoji} size={22} />
                      </button>
                    </DropdownMenu.Item>
                  );
                })}
                <DropdownMenu.Arrow className="fill-surface" />
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
        {copyText && <CopyMessageButton text={copyText} onError={setCopyError} />}
      </div>

      {copyError && (
        <span role="alert" className="basis-full text-[0.786rem] text-error-bright">
          {copyError}
        </span>
      )}
      {error && (
        <span
          role="alert"
          className="basis-full text-[0.786rem] text-error-bright"
        >
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
