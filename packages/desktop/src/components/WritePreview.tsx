import { truncateLines } from "../core/diff";

interface WritePreviewProps {
  content: string;
}

export function WritePreview({ content }: WritePreviewProps) {
  const allLines = content.split("\n");
  const { lines, omitted } = truncateLines(allLines);

  return (
    <div className="my-1 overflow-hidden rounded border border-border bg-base font-mono text-xs leading-normal">
      {lines.map((line, i) => (
        <div key={i} className="flex whitespace-pre-wrap break-all px-2 text-text-secondary">
          <span className="w-8 shrink-0 select-none pr-2 text-right text-text-dimmed">{i + 1}</span>
          <span>{line}</span>
        </div>
      ))}
      {omitted > 0 && (
        <div className="bg-raised px-2 py-1 text-[11px] italic text-text-dimmed">{omitted} more lines...</div>
      )}
    </div>
  );
}
