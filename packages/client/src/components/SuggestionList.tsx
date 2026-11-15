import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { menuContentClass } from "./ui";

export interface SuggestionListItem {
  key: string;
  section?: string;
  content: ReactNode;
}

interface SuggestionListProps<T> {
  items: T[];
  command: (item: T) => void;
  render: (item: T) => SuggestionListItem;
  label: string;
  testId: string;
  /** The editable element: it keeps focus, so it carries the combobox state. */
  editor?: { view: { dom: HTMLElement } };
}

export interface SuggestionListHandle {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

/**
 * A keyboard-and-mouse list for the # and : menus. Arrow keys and Home/End
 * move, Enter and Tab pick, Escape closes (handled by the suggestion).
 * Focus stays in the editor, which points assistive tech at the active
 * option with aria-activedescendant.
 */
function SuggestionListInner<T>(
  { items, command, render, label, testId, editor }: SuggestionListProps<T>,
  ref: React.Ref<SuggestionListHandle>,
) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => setSelectedIndex(0), [items]);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [selectedIndex]);

  const dom = editor?.view.dom;
  const open = items.length > 0;
  const optionId = (index: number) => `${listId}-option-${index}`;
  useEffect(() => {
    if (!dom || !open) return;
    dom.setAttribute("aria-controls", listId);
    dom.setAttribute("aria-expanded", "true");
    dom.setAttribute("aria-autocomplete", "list");
    return () => {
      dom.removeAttribute("aria-controls");
      dom.removeAttribute("aria-activedescendant");
      dom.removeAttribute("aria-autocomplete");
      dom.setAttribute("aria-expanded", "false");
    };
  }, [dom, open, listId]);
  useEffect(() => {
    if (dom && open) dom.setAttribute("aria-activedescendant", optionId(selectedIndex));
  }, [dom, open, selectedIndex]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
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
          if (event.shiftKey) return false;
          const item = items[selectedIndex];
          if (item) command(item);
          return true;
        }
        default:
          return false;
      }
    },
  }));

  if (!open) return null;
  const rendered = items.map(render);
  return (
    <div
      ref={listRef}
      id={listId}
      role="listbox"
      aria-label={label}
      aria-activedescendant={optionId(selectedIndex)}
      data-testid={testId}
      className={`flex max-h-[320px] w-[280px] max-w-[calc(100vw-16px)] flex-col gap-px overflow-y-auto ${menuContentClass}`}
    >
      {rendered.map((entry, index) => (
        <div key={entry.key}>
          {entry.section && entry.section !== rendered[index - 1]?.section && (
            <div
              aria-hidden="true"
              className="px-2 pb-0.5 pt-1.5 text-[0.714rem] font-semibold uppercase tracking-wider text-text-dimmed"
            >
              {entry.section}
            </div>
          )}
          <button
            id={optionId(index)}
            type="button"
            role="option"
            aria-selected={index === selectedIndex}
            data-index={index}
            data-suggestion-option={entry.key}
            tabIndex={-1}
            className={`flex w-full cursor-pointer items-center gap-2.5 rounded-lg border-none px-2 py-1.5 text-left font-[inherit] text-[0.929rem] outline-none transition-colors duration-75 ${
              index === selectedIndex ? "bg-hover text-text" : "bg-transparent text-text-secondary"
            }`}
            // Keep focus (and the caret) in the editor.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => command(items[index]!)}
            onMouseEnter={() => setSelectedIndex(index)}
          >
            {entry.content}
          </button>
        </div>
      ))}
    </div>
  );
}

export const SuggestionList = forwardRef(SuggestionListInner) as <T>(
  props: SuggestionListProps<T> & { ref?: React.Ref<SuggestionListHandle> },
) => ReturnType<typeof SuggestionListInner>;
