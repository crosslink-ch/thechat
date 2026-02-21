import { parseTextSegments } from "../core/ui-blocks";
import { DynamicUiBlock } from "./DynamicUiBlock";
import { PendingUiBlock } from "./PendingUiBlock";

export function TextWithUiBlocks({ text }: { text: string }) {
  const segments = parseTextSegments(text);

  return (
    <>
      {segments.map((segment, i) => {
        switch (segment.type) {
          case "text":
            return (
              <div key={i} className="message-text">
                {segment.content}
              </div>
            );
          case "ui":
            return <DynamicUiBlock key={i} code={segment.code} />;
          case "ui-pending":
            return <PendingUiBlock key={i} code={segment.code} />;
        }
      })}
    </>
  );
}
