import { useState, useDeferredValue, useRef, useEffect } from "react";
import type { Conversation } from "./core/types";
import { useStreamingConvIds } from "./stores/streaming";

interface CommandPaletteProps {
  conversations: Conversation[];
  currentId: string | undefined;
  onSelect: (conv: Conversation) => void;
  onClose: () => void;
  unreadAgentChats?: Set<string>;
}

export function CommandPalette({ conversations, currentId, onSelect, onClose, unreadAgentChats }: CommandPaletteProps) {
  const streamingConvIds = useStreamingConvIds();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const isStale = query !== deferredQuery;
  const [highlightIndex, setHighlightIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = conversations.filter((c) =>
    c.title.toLowerCase().includes(deferredQuery.toLowerCase())
  );

  useEffect(() => {
    setHighlightIndex(0);
  }, [deferredQuery]);

  useEffect(() => {
    const item = listRef.current?.children[highlightIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[highlightIndex]) {
        onSelect(filtered[highlightIndex]);
      }
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div className="palette-panel" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Search chats..."
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="palette-list" ref={listRef} style={{ opacity: isStale ? 0.6 : 1 }}>
          {filtered.map((conv, i) => {
            const isStreamingBg = streamingConvIds?.has(conv.id);
            const isUnread = unreadAgentChats?.has(conv.id);
            return (
              <button
                key={conv.id}
                className={`palette-item${i === highlightIndex ? " palette-item-highlighted" : ""}${conv.id === currentId ? " palette-item-active" : ""}`}
                onClick={() => onSelect(conv)}
                onMouseEnter={() => setHighlightIndex(i)}
              >
                <span className="palette-item-title">{conv.title}</span>
                {isStreamingBg && <span className="conv-streaming-indicator" />}
                {!isStreamingBg && isUnread && <span className="conv-unread-dot" />}
              </button>
            );
          })}
          {filtered.length === 0 && (
            <div className="palette-empty">No matching chats</div>
          )}
        </div>
      </div>
    </div>
  );
}
