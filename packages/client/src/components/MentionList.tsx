import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useId,
  useRef,
  useState,
} from "react";
import type { BotAppearance } from "@thechat/shared";
import { Avatar } from "./Avatar";
import { useProfilePicture } from "../hooks/useProfilePicture";
import { menuContentClass } from "./ui";
import { MENTION_SECTIONS, mentionDiscriminators } from "./mention-ranking";

export interface MentionUser {
  id: string;
  label: string;
  type: "human" | "bot";
  /** A person's profile picture. */
  picture?: string | null;
  botAvatar?: BotAppearance;
  /** A short public detail that tells equal names apart (e.g. "Hermes"). */
  detail?: string;
}

interface MentionListProps {
  items: MentionUser[];
  command: (item: MentionUser) => void;
}

/**
 * The @ menu: People, then Agents. Arrow keys, Home/End, Enter and Tab pick;
 * Escape closes (handled by the suggestion). Equal names show a short
 * discriminator so the right person or agent can be picked.
 */
export const MentionList = forwardRef<
  { onKeyDown: (props: { event: KeyboardEvent }) => boolean },
  MentionListProps
>(({ items, command }, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const hints = mentionDiscriminators(items);

  useEffect(() => {
    setSelectedIndex(0);
  }, [items]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [selectedIndex]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }: { event: KeyboardEvent }) => {
      if (items.length === 0) return false;
      switch (event.key) {
        case "ArrowUp":
          setSelectedIndex((i) => (i + items.length - 1) % items.length);
          return true;
        case "ArrowDown":
          setSelectedIndex((i) => (i + 1) % items.length);
          return true;
        case "Home":
          setSelectedIndex(0);
          return true;
        case "End":
          setSelectedIndex(items.length - 1);
          return true;
        case "Enter":
        case "Tab": {
          const item = items[selectedIndex];
          if (item) command(item);
          return true;
        }
        default:
          return false;
      }
    },
  }));

  if (items.length === 0) return null;

  const optionId = (index: number) => `${listId}-option-${index}`;
  let offset = 0;
  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Mention a person or agent"
      aria-activedescendant={optionId(selectedIndex)}
      data-testid="mention-menu"
      className={`flex max-h-[320px] w-[300px] max-w-[calc(100vw-16px)] flex-col gap-px overflow-y-auto ${menuContentClass}`}
    >
      {MENTION_SECTIONS.map((section) => {
        const sectionItems = items.filter((item) => item.type === section.type);
        if (sectionItems.length === 0) return null;
        const start = offset;
        offset += sectionItems.length;
        return (
          <div key={section.type} role="group" aria-label={section.title}>
            <div
              aria-hidden="true"
              className="px-2 pb-0.5 pt-1.5 text-[0.714rem] font-semibold uppercase tracking-wider text-text-dimmed"
            >
              {section.title}
            </div>
            {sectionItems.map((item, sectionIndex) => {
              const index = start + sectionIndex;
              const hint = hints.get(item.id);
              return (
                <button
                  key={item.id}
                  id={optionId(index)}
                  type="button"
                  role="option"
                  aria-selected={index === selectedIndex}
                  data-index={index}
                  data-mention-option={item.id}
                  tabIndex={-1}
                  className={`flex w-full cursor-pointer items-center gap-2.5 rounded-lg border-none px-2 py-1.5 text-left font-[inherit] text-[0.929rem] outline-none transition-colors duration-75 ${
                    index === selectedIndex ? "bg-hover text-text" : "bg-transparent text-text-secondary"
                  }`}
                  // Keep focus (and the caret) in the editor.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => command(item)}
                  onMouseEnter={() => setSelectedIndex(index)}
                >
                  <MentionAvatar item={item} />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {hint && (
                    <span className="shrink-0 text-[0.786rem] text-text-dimmed" data-mention-hint>
                      {hint}
                    </span>
                  )}
                  {item.type === "bot" && (
                    <span className="shrink-0 rounded-md bg-accent/15 px-1.5 py-0.5 text-[0.714rem] font-medium tracking-wide text-accent">
                      AGENT
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
});

function MentionAvatar({ item }: { item: MentionUser }) {
  const picture = useProfilePicture(item.id, item.picture);
  return <Avatar name={item.label} colorKey={item.id} picture={picture}
    bot={item.type === "bot"} botAvatar={item.botAvatar} size={24}
    className="size-6 text-[0.786rem]" />;
}

MentionList.displayName = "MentionList";
