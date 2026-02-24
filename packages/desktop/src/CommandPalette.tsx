import { useState, useDeferredValue, useMemo, useRef, useEffect } from "react";
import { create } from "zustand";
import { useNavigate, useMatches } from "@tanstack/react-router";
import { useConversationsStore } from "./stores/conversations";
import { useStreamingConvIds } from "./stores/streaming";
import { useCommandsStore } from "./commands";
import { closeSidebar } from "./components/Sidebar";

// Colocated visibility store
const usePaletteState = create(() => ({ open: false, initialQuery: "" }));
export const togglePalette = () =>
  usePaletteState.setState((s) => ({ open: !s.open, initialQuery: "" }));
export const closePalette = () =>
  usePaletteState.setState({ open: false, initialQuery: "" });
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
    closeSidebar();
    closePalette();
  };

  const handleSelectCommand = (index: number) => {
    const cmd = filteredCommands[index];
    if (cmd) cmd.execute();
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
      closePalette();
    }
  };

  return (
    <div className="palette-overlay" onClick={closePalette}>
      <div className="palette-panel" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder={isCommandMode ? "Type a command..." : "Search chats (type > for commands)"}
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div
          className="palette-list"
          ref={listRef}
          style={{ opacity: isStale ? 0.6 : 1 }}
        >
          {isCommandMode ? (
            <>
              {filteredCommands.map((cmd, i) => (
                <button
                  key={cmd.id}
                  className={`palette-item${i === highlightIndex ? " palette-item-highlighted" : ""}`}
                  onClick={() => handleSelectCommand(i)}
                  onMouseEnter={() => setHighlightIndex(i)}
                >
                  <span className="palette-item-title">{cmd.label}</span>
                  {cmd.shortcut && (
                    <kbd className="palette-shortcut">{cmd.shortcut}</kbd>
                  )}
                </button>
              ))}
              {filteredCommands.length === 0 && (
                <div className="palette-empty">No matching commands</div>
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
                    className={`palette-item${i === highlightIndex ? " palette-item-highlighted" : ""}${conv.id === currentId ? " palette-item-active" : ""}`}
                    onClick={() => handleSelectConversation(conv)}
                    onMouseEnter={() => setHighlightIndex(i)}
                  >
                    <span className="palette-item-title">{conv.title}</span>
                    {isStreamingBg && <span className="conv-streaming-indicator" />}
                    {!isStreamingBg && isUnread && <span className="conv-unread-dot" />}
                  </button>
                );
              })}
              {filteredConversations.length === 0 && (
                <div className="palette-empty">No matching chats</div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
