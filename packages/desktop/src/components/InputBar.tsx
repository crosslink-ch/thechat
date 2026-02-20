import { useState, useRef, useEffect } from "react";

interface InputBarProps {
  isStreaming: boolean;
  onSend: (content: string) => void;
  onStop: () => void;
}

export function InputBar({ isStreaming, onSend, onStop }: InputBarProps) {
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
    <div className="input-bar">
      <textarea
        ref={textareaRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type a message..."
        rows={1}
        disabled={isStreaming}
      />
      {isStreaming ? (
        <button className="send-btn stop-btn" onClick={onStop}>
          Stop
        </button>
      ) : (
        <button
          className="send-btn"
          onClick={handleSend}
          disabled={!input.trim()}
        >
          Send
        </button>
      )}
    </div>
  );
}
