import { useState, useRef, useEffect } from "react";
import { create } from "zustand";
import { usePermissionModeStore, type PermissionMode } from "@thechat/client/stores/permission-mode";
import { requestInputBarFocus } from "@thechat/client/stores/input-focus";

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
    <div className="fixed inset-0 z-20 flex items-start justify-center bg-overlay px-4 pt-20 backdrop-blur-[2px] animate-overlay-in" onClick={closePicker} onKeyDown={handleKeyDown}>
      <div className="w-full max-w-[400px] overflow-hidden rounded-xl border border-border bg-surface/95 shadow-card backdrop-blur-2xl backdrop-saturate-150 animate-menu-in" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 pb-1 pt-3 text-[0.786rem] font-medium text-text-dimmed">
          Permission mode
        </div>
        <div ref={listRef} tabIndex={-1} autoFocus className="p-1.5 outline-none">
          {modes.map((mode, i) => (
            <button
              key={mode.id}
              autoFocus={i === highlightIndex}
              className={`flex w-full cursor-pointer flex-col gap-0.5 rounded-lg border-none px-3 py-2.5 text-left font-[inherit] outline-none transition-colors duration-100 ${i === highlightIndex ? "bg-hover" : "bg-transparent hover:bg-hover"}`}
              onClick={() => handleSelect(mode.id)}
              onMouseEnter={() => setHighlightIndex(i)}
            >
              <span className={`flex items-center gap-2 text-[0.929rem] font-medium ${mode.style}`}>
                {mode.label}
                {mode.id === currentMode && (
                  <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[0.714rem] font-medium text-text-dimmed">current</span>
                )}
              </span>
              <span className="text-[0.857rem] text-text-dimmed">{mode.description}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
