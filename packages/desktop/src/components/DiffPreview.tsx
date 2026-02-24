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
    <div className="my-1 overflow-hidden rounded border border-border font-mono text-xs leading-normal">
      {label && <div className="border-b border-border bg-raised px-2 py-1 text-[11px] font-medium text-text-muted">{label}</div>}
      {lines.map((line, i) => (
        <div
          key={i}
          className={`flex whitespace-pre-wrap break-all px-2 ${line.type === "remove" ? "bg-error-bg text-error-light" : "bg-success-bg text-success-light"}`}
        >
          <span className="w-4 shrink-0 select-none opacity-60">{line.type === "remove" ? "-" : "+"}</span>
          <span>{line.text}</span>
        </div>
      ))}
      {omitted > 0 && (
        <div className="bg-raised px-2 py-1 text-[11px] italic text-text-dimmed">{omitted} more lines...</div>
      )}
    </div>
  );
}
