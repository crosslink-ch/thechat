import { computeDiffLines, truncateLines } from "../core/diff";

interface DiffPreviewProps {
  oldStr: string;
  newStr: string;
  label?: string;
}

export function DiffPreview({ oldStr, newStr, label }: DiffPreviewProps) {
  const allLines = computeDiffLines(oldStr, newStr);
  const { lines, omitted } = truncateLines(allLines);

  return (
    <div className="diff-preview">
      {label && <div className="multiedit-label">{label}</div>}
      {lines.map((line, i) => (
        <div
          key={i}
          className={line.type === "remove" ? "diff-line-remove" : "diff-line-add"}
        >
          <span className="diff-line-marker">{line.type === "remove" ? "-" : "+"}</span>
          <span>{line.text}</span>
        </div>
      ))}
      {omitted > 0 && (
        <div className="diff-truncated">{omitted} more lines...</div>
      )}
    </div>
  );
}
