import { truncateLines } from "../core/diff";

interface WritePreviewProps {
  content: string;
}

export function WritePreview({ content }: WritePreviewProps) {
  const allLines = content.split("\n");
  const { lines, omitted } = truncateLines(allLines);

  return (
    <div className="write-preview">
      {lines.map((line, i) => (
        <div key={i} className="write-preview-line">
          <span className="write-preview-lineno">{i + 1}</span>
          <span>{line}</span>
        </div>
      ))}
      {omitted > 0 && (
        <div className="diff-truncated">{omitted} more lines...</div>
      )}
    </div>
  );
}
