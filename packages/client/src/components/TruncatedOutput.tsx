import { useState, useMemo } from "react";
import { ChevronDown } from "lucide-react";

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
          className={`m-0 whitespace-pre-wrap font-mono text-[0.786rem] leading-relaxed ${isError ? "text-error-light" : "text-text-secondary"}`}
        >
          {displayText}
        </pre>
      </div>
      {isTruncated && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1.5 inline-flex cursor-pointer items-center gap-1 border-none bg-transparent p-0 text-[0.786rem] font-medium text-text-dimmed transition-colors duration-150 hover:text-text-secondary"
        >
          <ChevronDown
            size={14}
            aria-hidden="true"
            className={`transition-transform duration-150 ${expanded ? "rotate-180" : ""}`}
          />
          {expanded ? "Show less" : `Show ${totalLines - maxLines} more lines...`}
        </button>
      )}
    </div>
  );
}
