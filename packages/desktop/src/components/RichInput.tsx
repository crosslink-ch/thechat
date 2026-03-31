import { useCallback, useRef, useState, forwardRef, useImperativeHandle } from "react";
import { createPortal } from "react-dom";
import { MentionList, type MentionUser } from "./MentionList";

interface RichInputProps {
  onSubmit: (text: string) => void;
  /** Called when user presses Enter with empty text. Return true if handled (e.g., images-only send). */
  onEmptySubmitAttempt?: () => boolean;
  placeholder?: string;
  disabled?: boolean;
  mentions?: MentionUser[];
  onCanSubmitChange?: (canSubmit: boolean) => void;
}

export interface RichInputHandle {
  submit: () => void;
  focus: () => void;
}

/** Extract @mention query from text at cursor position, or null if not in a mention. */
function getMentionQuery(text: string, cursorPos: number): string | null {
  const before = text.slice(0, cursorPos);
  // Match @ at start of text or after whitespace, followed by word chars
  const match = before.match(/(?:^|\s)@(\w*)$/);
  return match ? match[1] : null;
}

export const RichInput = forwardRef<RichInputHandle, RichInputProps>(function RichInput(
  { onSubmit, onEmptySubmitAttempt, placeholder = "Send a message...", disabled = false, mentions, onCanSubmitChange },
  ref,
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const onEmptySubmitAttemptRef = useRef(onEmptySubmitAttempt);
  onEmptySubmitAttemptRef.current = onEmptySubmitAttempt;
  const onCanSubmitChangeRef = useRef(onCanSubmitChange);
  onCanSubmitChangeRef.current = onCanSubmitChange;
  const mentionsRef = useRef(mentions);
  mentionsRef.current = mentions;
  const lastCanSubmitRef = useRef(false);

  // Mention popup state
  const [mentionState, setMentionState] = useState<{
    query: string;
    items: MentionUser[];
    pos: { left: number; top: number };
  } | null>(null);
  const mentionListRef = useRef<{ onKeyDown: (props: { event: KeyboardEvent }) => boolean }>(null);

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, []);

  const clearAndResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.value = "";
    resize();
  }, [resize]);

  const doSubmit = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const trimmed = el.value.trim();
    if (!trimmed) {
      if (onEmptySubmitAttemptRef.current?.()) {
        clearAndResize();
      }
      return;
    }
    onSubmitRef.current(trimmed);
    clearAndResize();
    lastCanSubmitRef.current = false;
    onCanSubmitChangeRef.current?.(false);
  }, [clearAndResize]);

  useImperativeHandle(
    ref,
    () => ({
      submit: doSubmit,
      focus: () => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.selectionStart = el.selectionEnd = el.value.length;
      },
    }),
    [doSubmit],
  );

  const updateMentionPopup = useCallback(() => {
    const el = textareaRef.current;
    if (!el || !mentionsRef.current) {
      setMentionState(null);
      return;
    }
    const query = getMentionQuery(el.value, el.selectionStart);
    if (query === null) {
      setMentionState(null);
      return;
    }
    const q = query.toLowerCase();
    const items = mentionsRef.current.filter((m) => m.label.toLowerCase().includes(q));
    if (items.length === 0) {
      setMentionState(null);
      return;
    }
    const rect = el.getBoundingClientRect();
    setMentionState({ query, items, pos: { left: rect.left, top: rect.top - 4 } });
  }, []);

  const handleMentionSelect = useCallback(
    (item: MentionUser) => {
      const el = textareaRef.current;
      if (!el || !mentionState) return;
      const before = el.value.slice(0, el.selectionStart);
      const after = el.value.slice(el.selectionStart);
      const atIdx = before.lastIndexOf("@");
      const newBefore = before.slice(0, atIdx) + `@${item.label} `;
      el.value = newBefore + after;
      el.selectionStart = el.selectionEnd = newBefore.length;
      setMentionState(null);
      const canSubmit = el.value.trim().length > 0;
      if (canSubmit !== lastCanSubmitRef.current) {
        lastCanSubmitRef.current = canSubmit;
        onCanSubmitChangeRef.current?.(canSubmit);
      }
      resize();
      el.focus();
    },
    [mentionState, resize],
  );

  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const canSubmit = el.value.trim().length > 0;
    if (canSubmit !== lastCanSubmitRef.current) {
      lastCanSubmitRef.current = canSubmit;
      onCanSubmitChangeRef.current?.(canSubmit);
    }
    resize();
    updateMentionPopup();
  }, [resize, updateMentionPopup]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Delegate to mention popup if open
      if (mentionState && mentionListRef.current) {
        if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Enter") {
          if (mentionListRef.current.onKeyDown({ event: e.nativeEvent })) {
            e.preventDefault();
            return;
          }
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setMentionState(null);
          return;
        }
      }

      // Enter to submit, Shift+Enter for newline
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        doSubmit();
      }
    },
    [mentionState, doSubmit],
  );

  return (
    <>
      <textarea
        ref={textareaRef}
        className="block max-h-[200px] w-full resize-none overflow-y-auto bg-transparent px-4 pt-3 pb-11 font-[inherit] text-[1rem] leading-relaxed text-text outline-none placeholder:text-text-placeholder"
        placeholder={placeholder}
        disabled={disabled}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onSelect={mentions ? updateMentionPopup : undefined}
        rows={1}
      />
      {mentionState &&
        createPortal(
          <div
            style={{
              position: "absolute",
              left: mentionState.pos.left,
              top: mentionState.pos.top,
              transform: "translateY(-100%)",
              zIndex: 50,
            }}
          >
            <MentionList ref={mentionListRef} items={mentionState.items} command={handleMentionSelect} />
          </div>,
          document.body,
        )}
    </>
  );
});
