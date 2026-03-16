import { useEffect, useRef, useState } from "react";
import { useIsStreaming } from "../stores/streaming";
import { useInputFocusStore } from "../stores/input-focus";
import { RichInput, type RichInputHandle } from "./RichInput";
import type { MentionUser } from "./MentionList";

interface InputBarProps {
  convId: string | undefined;
  onSend: (content: string) => void;
  onStop: () => void;
  mentions?: MentionUser[];
  autoFocusKey?: string;
}

export function InputBar({ convId, onSend, onStop, mentions, autoFocusKey }: InputBarProps) {
  const isStreaming = useIsStreaming(convId);
  const inputRef = useRef<RichInputHandle>(null);
  const [canSubmit, setCanSubmit] = useState(false);

  useEffect(() => {
    if (!autoFocusKey) return;
    inputRef.current?.focus();
  }, [autoFocusKey]);

  // Re-focus when another UI surface (command palette, picker, etc.) requests it
  const focusTick = useInputFocusStore((s) => s.focusTick);
  useEffect(() => {
    if (focusTick > 0) {
      inputRef.current?.focus();
    }
  }, [focusTick]);

  return (
    <div className="px-4 pb-4 pt-2">
      <div className="relative rounded-xl border border-border bg-raised shadow-input transition-colors duration-150 focus-within:border-border-strong">
        <RichInput
          ref={inputRef}
          onSubmit={onSend}
          placeholder={isStreaming ? "Queue a message..." : "Send a message..."}
          mentions={mentions}
          onCanSubmitChange={setCanSubmit}
        />
        <div className="absolute right-2 bottom-2 flex items-center gap-1.5">
          {isStreaming && canSubmit && (
            <button
              className="flex size-8 cursor-pointer items-center justify-center rounded-lg border-none shadow-none transition-all duration-150 bg-accent/15 text-accent hover:bg-accent/25"
              onClick={() => inputRef.current?.submit()}
              title="Queue message"
            >
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7.5 12V3.5" />
                <path d="M3.5 7L7.5 3L11.5 7" />
              </svg>
            </button>
          )}
          {isStreaming ? (
            <button
              className="flex size-8 cursor-pointer items-center justify-center rounded-lg border-none bg-error/15 text-error-bright shadow-none transition-colors duration-150 hover:bg-error/25"
              onClick={onStop}
              title="Stop generating"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                <rect x="2" y="2" width="10" height="10" rx="1.5" />
              </svg>
            </button>
          ) : (
            <button
              className="flex size-8 cursor-pointer items-center justify-center rounded-lg border-none shadow-none transition-all duration-150 disabled:cursor-default disabled:opacity-25 bg-accent/15 text-accent hover:not-disabled:bg-accent/25"
              disabled={!canSubmit}
              onClick={() => inputRef.current?.submit()}
              title="Send message"
            >
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7.5 12V3.5" />
                <path d="M3.5 7L7.5 3L11.5 7" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
