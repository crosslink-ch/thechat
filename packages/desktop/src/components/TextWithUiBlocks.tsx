import { useMemo } from "react";
import { parseTextSegments } from "../core/ui-blocks";
import { DynamicUiBlock } from "./DynamicUiBlock";
import { Markdown } from "./Markdown";
import { PendingUiBlock } from "./PendingUiBlock";

interface TextWithUiBlocksProps {
  text: string;
  /** Suppress component error UI (shows pending-style placeholder instead). */
  isStreaming?: boolean;
}

export function TextWithUiBlocks({ text, isStreaming }: TextWithUiBlocksProps) {
  const segments = useMemo(() => parseTextSegments(text), [text]);

  return (
    <>
      {segments.map((segment, i) => {
        switch (segment.type) {
          case "text":
            return <Markdown key={i} content={segment.content} />;
          case "ui":
            return <DynamicUiBlock key={i} code={segment.code} isStreaming={isStreaming} />;
          case "ui-pending":
            return <PendingUiBlock key={i} code={segment.code} />;
        }
      })}
    </>
  );
}
