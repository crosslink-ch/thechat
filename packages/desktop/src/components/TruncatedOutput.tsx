import { useState, useMemo } from "react";

interface TruncatedOutputProps {
  text: string;
  maxLines?: number;
  isError?: boolean;
}

export function TruncatedOutput({ text, maxLines = 10, isError }: TruncatedOutputProps) {
  const [expanded, setExpanded] = useState(false);

  const lines = useMemo(() => text.split("\n"), [text]);
  const totalLines = lines.length;
  const isTruncated = totalLines > maxLines;
  const displayText = expanded || !isTruncated ? text : lines.slice(0, maxLines).join("\n");

  return (
    <div>
      <div className={expanded ? "max-h-[400px] overflow-y-auto" : undefined}>
        <pre
          className={`m-0 whitespace-pre-wrap font-mono text-[12px] ${isError ? "text-error-light" : "text-text-secondary"}`}
        >
          {displayText}
        </pre>
      </div>
      {isTruncated && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 cursor-pointer border-none bg-transparent p-0 font-mono text-[11px] text-text-muted hover:text-text-secondary"
        >
          {expanded ? "Show less" : `Show ${totalLines - maxLines} more lines...`}
        </button>
      )}
    </div>
  );
}
