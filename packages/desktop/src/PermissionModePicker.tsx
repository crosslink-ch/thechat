import { useState, useRef, useEffect } from "react";
import { create } from "zustand";
import { usePermissionModeStore, type PermissionMode } from "./stores/permission-mode";
import { requestInputBarFocus } from "./stores/input-focus";

const usePickerState = create(() => ({ open: false }));
export const openPermissionModePicker = () => usePickerState.setState({ open: true });
const closePicker = () => {
  usePickerState.setState({ open: false });
  requestInputBarFocus();
};

const modes: { id: PermissionMode; label: string; description: string; style: string }[] = [
  {
    id: "request",
    label: "Request",
    description: "Ask permission for every action",
    style: "text-text",
  },
  {
    id: "allow-edits",
    label: "Allow Edits",
    description: "Auto-allow file edits, prompt for shell commands",
    style: "text-warning-text",
  },
  {
    id: "bypass",
    label: "Bypass Permissions",
    description: "Auto-allow all actions without prompting",
    style: "text-error-bright",
  },
];

export function PermissionModePicker() {
  const { open } = usePickerState();
  if (!open) return null;
  return <PermissionModePickerInner />;
}

function PermissionModePickerInner() {
  const currentMode = usePermissionModeStore((s) => s.mode);
  const [highlightIndex, setHighlightIndex] = useState(() =>
    modes.findIndex((m) => m.id === currentMode),
  );
  const listRef = useRef<HTMLDivElement>(null);

  const handleSelect = (mode: PermissionMode) => {
    usePermissionModeStore.getState().setMode(mode);
    closePicker();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex((i) => Math.min(i + 1, modes.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      handleSelect(modes[highlightIndex].id);
    } else if (e.key === "Escape") {
      closePicker();
    }
  };

  useEffect(() => {
    const item = listRef.current?.children[highlightIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  return (
    <div className="fixed inset-0 z-20 flex items-start justify-center bg-overlay pt-20 backdrop-blur-[2px] animate-fade-in" onClick={closePicker} onKeyDown={handleKeyDown}>
      <div className="w-full max-w-[400px] overflow-hidden rounded-xl border border-border-strong bg-surface shadow-card animate-slide-up" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-border px-4 py-3 text-[13px] font-medium text-text-secondary">
          Permission Mode
        </div>
        <div ref={listRef} tabIndex={-1} autoFocus>
          {modes.map((mode, i) => (
            <button
              key={mode.id}
              autoFocus={i === highlightIndex}
              className={`flex w-full cursor-pointer flex-col gap-0.5 border-none bg-none px-4 py-3 text-left font-[inherit] transition-colors duration-75 ${i === highlightIndex ? "bg-elevated" : "hover:bg-hover"}`}
              onClick={() => handleSelect(mode.id)}
              onMouseEnter={() => setHighlightIndex(i)}
            >
              <span className={`flex items-center gap-2 text-[13px] font-medium ${mode.style}`}>
                {mode.label}
                {mode.id === currentMode && (
                  <span className="rounded-md bg-elevated px-1.5 py-0.5 text-[10px] font-medium text-text-dimmed">current</span>
                )}
              </span>
              <span className="text-[12px] text-text-dimmed">{mode.description}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
