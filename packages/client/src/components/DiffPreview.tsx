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
    <div className="my-1 overflow-hidden rounded-lg border border-border-subtle bg-raised font-mono text-[0.786rem] leading-relaxed">
      {label && <div className="border-b border-border-subtle px-3 py-1.5 font-sans text-[0.786rem] font-medium text-text-muted">{label}</div>}
      {lines.map((line, i) => (
        <div
          key={i}
          className={`flex whitespace-pre-wrap break-all px-3 ${line.type === "remove" ? "bg-error-bg text-error-light" : "bg-success-bg text-success-light"}`}
        >
          <span className="w-4 shrink-0 select-none opacity-60">{line.type === "remove" ? "-" : "+"}</span>
          <span>{line.text}</span>
        </div>
      ))}
      {omitted > 0 && (
        <div className="border-t border-border-subtle px-3 py-1.5 font-sans text-[0.786rem] text-text-dimmed">{omitted} more lines...</div>
      )}
    </div>
  );
}
