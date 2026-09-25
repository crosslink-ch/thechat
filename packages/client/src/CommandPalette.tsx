import { useState, useDeferredValue, useMemo, useRef, useEffect } from "react";
import { create } from "zustand";
import { useCommandsStore } from "./commands";
import { requestInputBarFocus } from "./stores/input-focus";
import { Search } from "lucide-react";
import { dialogSurfaceClass, menuItemBaseClass } from "./components/ui";

const usePaletteState = create(() => ({ open: false, initialQuery: "" }));

export const togglePalette = () =>
  usePaletteState.setState((s) => ({ open: !s.open, initialQuery: "" }));

export const closePalette = () =>
  usePaletteState.setState({ open: false, initialQuery: "" });

/** Close the palette and request the active message input to re-focus. */
export function closePaletteAndRefocus() {
  closePalette();
  requestInputBarFocus();
}

export const openPaletteInCommandMode = () =>
  usePaletteState.setState({ open: true, initialQuery: "" });

export function CommandPalette() {
  const { open } = usePaletteState();
  if (!open) return null;
  return <CommandPaletteInner />;
}

function CommandPaletteInner() {
  const commands = useCommandsStore((s) => s.commands);
  const initialQuery = usePaletteState((s) => s.initialQuery);

  const [query, setQuery] = useState(initialQuery);
  const deferredQuery = useDeferredValue(query);
  const isStale = query !== deferredQuery;
  const [highlightIndex, setHighlightIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const commandQuery = deferredQuery.startsWith(">")
    ? deferredQuery.slice(1).trimStart()
    : deferredQuery;

  const filteredCommands = useMemo(
    () =>
      commands.filter((cmd) =>
        !cmd.hidden &&
        cmd.label.toLowerCase().includes(commandQuery.toLowerCase()),
      ),
    [commands, commandQuery],
  );

  useEffect(() => {
    setHighlightIndex(0);
  }, [deferredQuery]);

  useEffect(() => {
    const item = listRef.current?.children[highlightIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  const handleSelectCommand = (index: number) => {
    const cmd = filteredCommands[index];
    if (!cmd) return;
    cmd.execute();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex((i) => Math.min(i + 1, Math.max(filteredCommands.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      handleSelectCommand(highlightIndex);
    } else if (e.key === "Escape") {
      closePaletteAndRefocus();
    }
  };

  return (
    <div className="fixed inset-0 z-20 flex items-start justify-center bg-overlay px-4 pt-[16vh] backdrop-blur-[2px] animate-overlay-in" onClick={closePaletteAndRefocus}>
      <div data-testid="palette-panel" className={`w-full max-w-[560px] overflow-hidden animate-dialog-in ${dialogSurfaceClass}`} onClick={(e) => e.stopPropagation()}>
        <div className="relative">
          <Search size={16} className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-text-dimmed" aria-hidden="true" />
          <input
            ref={inputRef}
            className="h-[52px] w-full border-b border-border bg-transparent pr-4 pl-11 font-[inherit] text-[1.071rem] text-text outline-none placeholder:text-text-placeholder"
            placeholder="Type a command..."
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div
          className="max-h-[320px] overflow-y-auto p-1.5"
          ref={listRef}
          style={{ opacity: isStale ? 0.6 : 1 }}
        >
          {filteredCommands.map((cmd, i) => (
            <button
              key={cmd.id}
              data-testid="palette-item"
              className={`${menuItemBaseClass} py-2 ${i === highlightIndex ? "bg-hover text-text" : "text-text-secondary"}`}
              onClick={() => handleSelectCommand(i)}
              onMouseEnter={() => setHighlightIndex(i)}
            >
              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{cmd.label}</span>
              {cmd.shortcut && (
                <kbd className="ml-auto rounded-md bg-white/[0.06] px-1.5 py-0.5 font-mono text-[0.714rem] text-text-dimmed">{cmd.shortcut}</kbd>
              )}
            </button>
          ))}
          {filteredCommands.length === 0 && (
            <div className="px-4 py-5 text-center text-[0.929rem] text-text-placeholder">No matching commands</div>
          )}
        </div>
      </div>
    </div>
  );
}
