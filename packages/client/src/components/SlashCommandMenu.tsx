import { useEffect, useRef } from "react";
import type { HermesSlashCommand } from "../lib/hermes-slash-commands";
import { menuContentClass } from "./ui";

interface SlashCommandMenuProps {
  commands: HermesSlashCommand[];
  selectedIndex: number;
  onSelect: (command: HermesSlashCommand) => void;
  onHighlight: (index: number) => void;
}

/**
 * Telegram-style command menu floating above the input: a keyboard-navigable
 * list of "/command argsHint — description" rows. The parent owns the
 * selection state and key handling; this component renders and scrolls it.
 */
export function SlashCommandMenu({
  commands,
  selectedIndex,
  onSelect,
  onHighlight,
}: SlashCommandMenuProps) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selected = list.children[selectedIndex] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (commands.length === 0) return null;

  return (
    <div
      data-testid="slash-command-menu"
      className={`absolute bottom-full left-0 right-0 z-20 mb-2 ${menuContentClass}`}
    >
      <div ref={listRef} className="flex max-h-72 flex-col gap-px overflow-y-auto">
        {commands.map((command, index) => (
          <button
            key={command.command}
            type="button"
            data-testid={`slash-command-item-${command.command.slice(1)}`}
            data-selected={index === selectedIndex || undefined}
            className={`flex w-full shrink-0 cursor-pointer items-baseline gap-2 rounded-lg border-none px-2.5 py-1.5 text-left font-[inherit] shadow-none outline-none transition-colors duration-75 ${
              index === selectedIndex ? "bg-hover" : "bg-transparent"
            }`}
            // Select on mousedown so the input doesn't lose focus first.
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(command);
            }}
            onMouseMove={() => {
              if (index !== selectedIndex) onHighlight(index);
            }}
          >
            <span className="shrink-0 font-mono text-[0.857rem] font-medium text-text">
              {command.command}
            </span>
            {command.argsHint && (
              <span className="shrink-0 font-mono text-[0.786rem] text-text-dimmed">
                {command.argsHint}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate text-right text-[0.857rem] text-text-dimmed">
              {command.description}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
