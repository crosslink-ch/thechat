import { useState, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { basename } from "../lib/path";

interface ProjectPickerProps {
  projectDir: string | null;
  onSelect: (dir: string | null) => void;
  readOnly?: boolean;
}

export function ProjectPicker({ projectDir, onSelect, readOnly }: ProjectPickerProps) {
  const [displayName, setDisplayName] = useState<string | null>(null);

  useEffect(() => {
    if (projectDir) {
      basename(projectDir).then(setDisplayName);
    } else {
      setDisplayName(null);
    }
  }, [projectDir]);

  const handleClick = async () => {
    if (readOnly) return;
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") {
      onSelect(selected);
    }
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!readOnly) onSelect(null);
  };

  if (readOnly && !projectDir) return null;

  return (
    <button
      className={`inline-flex max-w-[200px] items-center gap-1.5 rounded-md border border-border bg-raised px-2.5 py-1 text-xs text-text-secondary transition-[background,border-color] duration-150 ${readOnly ? "cursor-default opacity-80" : "cursor-pointer hover:border-border-strong hover:bg-hover"}`}
      onClick={handleClick}
      title={projectDir ?? "No project selected"}
    >
      <span className="shrink-0 text-[13px]">&#128193;</span>
      <span className="overflow-hidden text-ellipsis whitespace-nowrap">
        {displayName ?? "No project"}
      </span>
      {projectDir && !readOnly && (
        <span className="shrink-0 text-sm leading-none text-text-muted hover:text-text" onClick={handleClear}>
          &times;
        </span>
      )}
    </button>
  );
}
