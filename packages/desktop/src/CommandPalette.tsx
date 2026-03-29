import { useState, useDeferredValue, useMemo, useRef, useEffect } from "react";
import { create } from "zustand";
import { useNavigate, useMatches } from "@tanstack/react-router";
import { useConversationsStore } from "./stores/conversations";
import { useStreamingConvIds } from "./stores/streaming";
import { useCommandsStore } from "./commands";
import { requestInputBarFocus } from "./stores/input-focus";

// Colocated visibility store
const usePaletteState = create(() => ({ open: false, initialQuery: "" }));
export const togglePalette = () =>
  usePaletteState.setState((s) => ({ open: !s.open, initialQuery: "" }));
export const closePalette = () =>
  usePaletteState.setState({ open: false, initialQuery: "" });

/** Close the palette and request the input bar to re-focus. */
export function closePaletteAndRefocus() {
  closePalette();
  requestInputBarFocus();
}
export const openPaletteInCommandMode = () =>
  usePaletteState.setState({ open: true, initialQuery: ">" });

export function CommandPalette() {
  const { open } = usePaletteState();
  if (!open) return null;
  return <CommandPaletteInner />;
}

function CommandPaletteInner() {
  const navigate = useNavigate();
  const matches = useMatches();
  const lastMatch = matches[matches.length - 1];
  const routeParams = (lastMatch?.params ?? {}) as Record<string, string>;
  const currentId = routeParams.id;

  const conversations = useConversationsStore((s) => s.conversations);
  const unreadAgentChats = useConversationsStore((s) => s.unreadAgentChats);
  const streamingConvIds = useStreamingConvIds();
  const commands = useCommandsStore((s) => s.commands);
  const initialQuery = usePaletteState((s) => s.initialQuery);

  const [query, setQuery] = useState(initialQuery);
  const deferredQuery = useDeferredValue(query);
  const isStale = query !== deferredQuery;
  const [highlightIndex, setHighlightIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const isCommandMode = query.startsWith(">");
  const deferredCommandQuery = isCommandMode ? deferredQuery.slice(1).trimStart() : "";

  const filteredConversations = useMemo(
    () =>
      isCommandMode
        ? []
        : conversations.filter((c) =>
            c.title.toLowerCase().includes(deferredQuery.toLowerCase()),
          ),
    [conversations, deferredQuery, isCommandMode],
  );

  const filteredCommands = useMemo(
    () =>
      isCommandMode
        ? commands.filter((cmd) =>
            !cmd.hidden &&
            cmd.label.toLowerCase().includes(deferredCommandQuery.toLowerCase()),
          )
        : [],
    [commands, deferredCommandQuery, isCommandMode],
  );

  const listLength = isCommandMode ? filteredCommands.length : filteredConversations.length;

  useEffect(() => {
    setHighlightIndex(0);
  }, [deferredQuery]);

  useEffect(() => {
    const item = listRef.current?.children[highlightIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  const handleSelectConversation = (conv: { id: string }) => {
    navigate({ to: "/chat/$id", params: { id: conv.id } });
    useConversationsStore.getState().markAgentChatRead(conv.id);
    closePaletteAndRefocus();
  };

  const handleSelectCommand = (index: number) => {
    const cmd = filteredCommands[index];
    if (!cmd) return;
    cmd.execute();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex((i) => Math.min(i + 1, listLength - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (isCommandMode) {
        handleSelectCommand(highlightIndex);
      } else if (filteredConversations[highlightIndex]) {
        handleSelectConversation(filteredConversations[highlightIndex]);
      }
    } else if (e.key === "Escape") {
      closePaletteAndRefocus();
    }
  };

  return (
    <div className="fixed inset-0 z-20 flex items-start justify-center bg-overlay pt-20 backdrop-blur-[2px] animate-fade-in" onClick={closePaletteAndRefocus}>
      <div data-testid="palette-panel" className="w-full max-w-[500px] overflow-hidden rounded-xl border border-border-strong bg-surface shadow-card animate-slide-up" onClick={(e) => e.stopPropagation()}>
        <div className="relative">
          <svg className="absolute top-1/2 left-3.5 -translate-y-1/2 text-text-dimmed" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
            <circle cx="6" cy="6" r="4.5" />
            <path d="M9.5 9.5L12.5 12.5" />
          </svg>
          <input
            ref={inputRef}
            className="w-full border-b border-border bg-transparent py-3 pr-4 pl-10 font-[inherit] text-[1rem] text-text outline-none placeholder:text-text-placeholder"
            placeholder={isCommandMode ? "Type a command..." : "Search chats (type > for commands)"}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div
          className="max-h-[300px] overflow-y-auto"
          ref={listRef}
          style={{ opacity: isStale ? 0.6 : 1 }}
        >
          {isCommandMode ? (
            <>
              {filteredCommands.map((cmd, i) => (
                <button
                  key={cmd.id}
                  data-testid="palette-item"
                  className={`flex w-full cursor-pointer items-center gap-1.5 border-none bg-none px-4 py-2.5 text-left font-[inherit] text-[0.929rem] text-text-muted transition-colors duration-75 ${i === highlightIndex ? "bg-elevated text-text" : "hover:bg-hover hover:text-text"}`}
                  onClick={() => handleSelectCommand(i)}
                  onMouseEnter={() => setHighlightIndex(i)}
                >
                  <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{cmd.label}</span>
                  {cmd.shortcut && (
                    <kbd className="ml-auto rounded border border-border bg-base px-1.5 py-0.5 font-mono text-[0.714rem] text-text-dimmed">{cmd.shortcut}</kbd>
                  )}
                </button>
              ))}
              {filteredCommands.length === 0 && (
                <div className="px-4 py-5 text-center text-[0.929rem] text-text-placeholder">No matching commands</div>
              )}
            </>
          ) : (
            <>
              {filteredConversations.map((conv, i) => {
                const isStreamingBg = streamingConvIds?.has(conv.id);
                const isUnread = unreadAgentChats?.has(conv.id);
                return (
                  <button
                    key={conv.id}
                    data-testid="palette-item"
                    className={`flex w-full cursor-pointer items-center gap-1.5 border-none bg-none px-4 py-2.5 text-left font-[inherit] text-[0.929rem] text-text-muted transition-colors duration-75 ${i === highlightIndex ? "bg-elevated text-text" : "hover:bg-hover hover:text-text"} ${conv.id === currentId ? "text-accent" : ""}`}
                    onClick={() => handleSelectConversation(conv)}
                    onMouseEnter={() => setHighlightIndex(i)}
                  >
                    <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{conv.title}</span>
                    {isStreamingBg && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />}
                    {!isStreamingBg && isUnread && <span className="size-1.5 shrink-0 rounded-full bg-accent" />}
                  </button>
                );
              })}
              {filteredConversations.length === 0 && (
                <div className="px-4 py-5 text-center text-[0.929rem] text-text-placeholder">No matching chats</div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
