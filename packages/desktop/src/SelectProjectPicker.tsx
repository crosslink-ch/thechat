import { useMemo, useState, useRef, useEffect } from "react";
import { create } from "zustand";
import { requestInputBarFocus } from "./stores/input-focus";

interface PickerState {
  open: boolean;
  recentProjects: string[];
  onSelect: ((projectDir: string) => void) | null;
}

const usePickerState = create<PickerState>(() => ({
  open: false,
  recentProjects: [],
  onSelect: null,
}));

export const openSelectProjectPicker = (
  recentProjects: string[],
  onSelect: (projectDir: string) => void,
) => {
  usePickerState.setState({ open: true, recentProjects, onSelect });
};

const closePicker = () => {
  usePickerState.setState({ open: false, recentProjects: [], onSelect: null });
  requestInputBarFocus();
};

type ProjectOption =
  | { id: string; type: "recent"; path: string }
  | { id: string; type: "typed"; path: string };

export function SelectProjectPicker() {
  const { open } = usePickerState();
  if (!open) return null;
  return <SelectProjectPickerInner />;
}

function SelectProjectPickerInner() {
  const recentProjects = usePickerState((s) => s.recentProjects);
  const onSelect = usePickerState((s) => s.onSelect);
  const [query, setQuery] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const options = useMemo<ProjectOption[]>(() => {
    const trimmed = query.trim();
    const filtered = trimmed
      ? recentProjects.filter((project) =>
          project.toLowerCase().includes(trimmed.toLowerCase()),
        )
      : recentProjects;

    const next: ProjectOption[] = filtered.map((project) => ({
      id: `recent:${project}`,
      type: "recent",
      path: project,
    }));

    if (trimmed.length > 0 && !recentProjects.includes(trimmed)) {
      next.unshift({
        id: `typed:${trimmed}`,
        type: "typed",
        path: trimmed,
      });
    }

    return next;
  }, [recentProjects, query]);

  useEffect(() => {
    setHighlightIndex(0);
  }, [query]);

  useEffect(() => {
    const item = listRef.current?.children[highlightIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  const handleSelect = (option: ProjectOption | undefined) => {
    if (!option || !onSelect) return;
    onSelect(option.path);
    closePicker();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      handleSelect(options[highlightIndex]);
    } else if (e.key === "Escape") {
      closePicker();
    }
  };

  return (
    <div
      className="fixed inset-0 z-20 flex items-start justify-center bg-overlay pt-20 backdrop-blur-[2px] animate-fade-in"
      onClick={closePicker}
    >
      <div
        className="w-full max-w-[560px] overflow-hidden rounded-xl border border-border-strong bg-surface shadow-card animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border px-4 py-3 text-[0.929rem] font-medium text-text-secondary">
          Select project
        </div>
        <input
          className="w-full border-b border-border bg-transparent px-4 py-3 font-[inherit] text-[0.929rem] text-text outline-none placeholder:text-text-placeholder"
          placeholder="Search recent projects or type a project path..."
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div ref={listRef} className="max-h-[300px] overflow-y-auto">
          {options.map((option, i) => {
            const projectName =
              option.path.split("/").filter(Boolean).pop() || option.path;
            return (
              <button
                key={option.id}
                className={`flex w-full cursor-pointer flex-col gap-0.5 border-none bg-none px-4 py-2.5 text-left font-[inherit] transition-colors duration-75 ${i === highlightIndex ? "bg-elevated" : "hover:bg-hover"}`}
                onClick={() => handleSelect(option)}
                onMouseEnter={() => setHighlightIndex(i)}
              >
                <span className="text-[0.929rem] text-text">
                  {option.type === "typed" ? `Use path: ${option.path}` : projectName}
                </span>
                {option.type === "recent" && (
                  <span className="truncate text-[0.786rem] text-text-dimmed">{option.path}</span>
                )}
              </button>
            );
          })}
          {options.length === 0 && (
            <div className="px-4 py-5 text-center text-[0.929rem] text-text-placeholder">
              No recent projects. Type a project path and press Enter.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
