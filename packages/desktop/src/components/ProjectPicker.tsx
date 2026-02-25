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
      className={`inline-flex max-w-[220px] items-center gap-2 rounded-lg border border-border bg-raised px-3 py-1.5 text-[12px] text-text-secondary transition-all duration-150 ${readOnly ? "cursor-default opacity-70" : "cursor-pointer hover:border-border-strong hover:bg-hover"}`}
      onClick={handleClick}
      title={projectDir ?? "No project selected"}
    >
      <svg className="shrink-0 text-text-dimmed" width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1.5 3.5V10.5C1.5 11.05 1.95 11.5 2.5 11.5H10.5C11.05 11.5 11.5 11.05 11.5 10.5V5C11.5 4.45 11.05 4 10.5 4H6.5L5 2H2.5C1.95 2 1.5 2.45 1.5 3V3.5Z" />
      </svg>
      <span className="overflow-hidden text-ellipsis whitespace-nowrap">
        {displayName ?? "No project"}
      </span>
      {projectDir && !readOnly && (
        <span className="shrink-0 text-[13px] leading-none text-text-dimmed transition-colors duration-150 hover:text-text-muted" onClick={handleClear}>
          &times;
        </span>
      )}
    </button>
  );
}
