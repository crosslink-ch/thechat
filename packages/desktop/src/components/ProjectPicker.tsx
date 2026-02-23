import { open } from "@tauri-apps/plugin-dialog";

interface ProjectPickerProps {
  projectDir: string | null;
  onSelect: (dir: string | null) => void;
  readOnly?: boolean;
}

function folderName(path: string): string {
  const parts = path.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

export function ProjectPicker({ projectDir, onSelect, readOnly }: ProjectPickerProps) {
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
      className={`project-picker ${readOnly ? "project-picker-readonly" : ""}`}
      onClick={handleClick}
      title={projectDir ?? "No project selected"}
    >
      <span className="project-picker-icon">&#128193;</span>
      <span className="project-picker-label">
        {projectDir ? folderName(projectDir) : "No project"}
      </span>
      {projectDir && !readOnly && (
        <span className="project-picker-clear" onClick={handleClear}>
          &times;
        </span>
      )}
    </button>
  );
}
