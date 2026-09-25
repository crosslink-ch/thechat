import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
} from "react";
import { Avatar } from "./Avatar";
import { menuContentClass } from "./ui";

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
    <div className={`flex max-w-[280px] flex-col gap-px ${menuContentClass}`}>
      {items.map((item, index) => (
        <button
          key={item.id}
          className={`flex cursor-pointer items-center gap-2.5 rounded-lg border-none px-2 py-1.5 text-left font-[inherit] text-[0.929rem] outline-none transition-colors duration-75 ${
            index === selectedIndex ? "bg-hover text-text" : "bg-transparent text-text-secondary"
          }`}
          onClick={() => command(item)}
          onMouseEnter={() => setSelectedIndex(index)}
        >
          <Avatar name={item.label} colorKey={item.id} className="size-6 text-[0.786rem]" />
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {item.type === "bot" && (
            <span className="rounded-md bg-accent/15 px-1.5 py-0.5 text-[0.714rem] font-medium tracking-wide text-accent">
              BOT
            </span>
          )}
        </button>
      ))}
    </div>
  );
});

MentionList.displayName = "MentionList";
