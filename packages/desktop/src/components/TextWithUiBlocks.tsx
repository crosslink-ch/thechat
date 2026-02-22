import { useMemo } from "react";
import { parseTextSegments } from "../core/ui-blocks";
import { DynamicUiBlock } from "./DynamicUiBlock";
import { Markdown } from "./Markdown";
import { PendingUiBlock } from "./PendingUiBlock";

export function TextWithUiBlocks({ text }: { text: string }) {
  const segments = useMemo(() => parseTextSegments(text), [text]);

  return (
    <>
      {segments.map((segment, i) => {
        switch (segment.type) {
          case "text":
            return <Markdown key={i} content={segment.content} />;
          case "ui":
            return <DynamicUiBlock key={i} code={segment.code} />;
          case "ui-pending":
            return <PendingUiBlock key={i} code={segment.code} />;
        }
      })}
    </>
  );
}
