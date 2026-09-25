import { truncateLines } from "../core/diff";

interface WritePreviewProps {
  content: string;
}

export function WritePreview({ content }: WritePreviewProps) {
  const allLines = content.split("\n");
  const { lines, omitted } = truncateLines(allLines);

  return (
    <div className="my-1 overflow-hidden rounded-lg border border-border-subtle bg-raised py-1 font-mono text-[0.786rem] leading-relaxed">
      {lines.map((line, i) => (
        <div key={i} className="flex whitespace-pre-wrap break-all px-2 text-text-secondary">
          <span className="w-8 shrink-0 select-none pr-3 text-right text-text-dimmed">{i + 1}</span>
          <span>{line}</span>
        </div>
      ))}
      {omitted > 0 && (
        <div className="mt-1 border-t border-border-subtle px-3 pt-1.5 pb-0.5 font-sans text-[0.786rem] text-text-dimmed">{omitted} more lines...</div>
      )}
    </div>
  );
}
