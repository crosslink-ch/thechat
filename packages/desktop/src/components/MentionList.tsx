import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
} from "react";

export interface MentionUser {
  id: string;
  label: string;
  type: "human" | "bot";
}

interface MentionListProps {
  items: MentionUser[];
  command: (item: MentionUser) => void;
}

export const MentionList = forwardRef<
  { onKeyDown: (props: { event: KeyboardEvent }) => boolean },
  MentionListProps
>(({ items, command }, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    setSelectedIndex(0);
  }, [items]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }: { event: KeyboardEvent }) => {
      if (event.key === "ArrowUp") {
        setSelectedIndex((i) => (i + items.length - 1) % items.length);
        return true;
      }
      if (event.key === "ArrowDown") {
        setSelectedIndex((i) => (i + 1) % items.length);
        return true;
      }
      if (event.key === "Enter") {
        const item = items[selectedIndex];
        if (item) command(item);
        return true;
      }
      return false;
    },
  }));

  if (items.length === 0) return null;

  return (
    <div className="flex flex-col rounded-lg border border-border bg-raised py-1 shadow-card">
      {items.map((item, index) => (
        <button
          key={item.id}
          className={`flex cursor-pointer items-center gap-2 border-none bg-transparent px-3 py-1.5 text-left text-[0.929rem] text-text transition-colors duration-75 ${
            index === selectedIndex ? "bg-hover" : ""
          }`}
          onClick={() => command(item)}
          onMouseEnter={() => setSelectedIndex(index)}
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-elevated text-[0.786rem] font-semibold text-text-muted">
            {item.label.charAt(0).toUpperCase()}
          </span>
          <span className="flex-1 truncate">{item.label}</span>
          {item.type === "bot" && (
            <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[0.714rem] font-medium text-accent">
              BOT
            </span>
          )}
        </button>
      ))}
    </div>
  );
});

MentionList.displayName = "MentionList";
