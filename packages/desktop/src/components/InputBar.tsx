import { useState, useRef, useEffect } from "react";
import { useIsStreaming } from "../stores/streaming";

interface InputBarProps {
  convId: string | undefined;
  onSend: (content: string) => void;
  onStop: () => void;
}

export function InputBar({ convId, onSend, onStop }: InputBarProps) {
  const isStreaming = useIsStreaming(convId);
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 200) + "px";
    }
  }, [input]);

  const handleSend = () => {
    if (!input.trim() || isStreaming) return;
    const content = input;
    setInput("");
    onSend(content);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex items-end gap-2 border-t border-border bg-surface px-4 py-3">
      <textarea
        ref={textareaRef}
        className="max-h-[200px] flex-1 resize-none rounded-xl border border-border bg-base px-3.5 py-2.5 font-[inherit] text-[15px] leading-normal text-text outline-none placeholder:text-text-placeholder focus:border-border-focus"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type a message..."
        rows={1}
        disabled={isStreaming}
      />
      {isStreaming ? (
        <button className="cursor-pointer whitespace-nowrap rounded-xl border-none bg-danger-bg px-5 py-2.5 text-sm font-medium text-text shadow-none hover:bg-danger-bg-hover" onClick={onStop}>
          Stop
        </button>
      ) : (
        <button
          className="cursor-pointer whitespace-nowrap rounded-xl border-none bg-button px-5 py-2.5 text-sm font-medium text-text shadow-none hover:not-disabled:bg-button-hover disabled:cursor-default disabled:opacity-40"
          onClick={handleSend}
          disabled={!input.trim()}
        >
          Send
        </button>
      )}
    </div>
  );
}
