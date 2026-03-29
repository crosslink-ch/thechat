import { memo, useEffect, useRef, useState, useCallback, type DragEvent } from "react";
import { useIsStreaming } from "../stores/streaming";
import { useInputFocusStore } from "../stores/input-focus";
import { RichInput, type RichInputHandle } from "./RichInput";
import type { MentionUser } from "./MentionList";
import type { ImageAttachment } from "../lib/images";

const ACCEPTED_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/bmp"]);

function fileToAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1];
      resolve({ id: crypto.randomUUID(), mimeType: file.type, base64 });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

interface InputBarProps {
  convId: string | undefined;
  onSend: (content: string, images?: ImageAttachment[]) => void;
  onStop: () => void;
  mentions?: MentionUser[];
  autoFocusKey?: string;
}

export const InputBar = memo(function InputBar({ convId, onSend, onStop, mentions, autoFocusKey }: InputBarProps) {
  const isStreaming = useIsStreaming(convId);
  const inputRef = useRef<RichInputHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [canSubmit, setCanSubmit] = useState(false);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const hasContent = canSubmit || images.length > 0;

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

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const validFiles = Array.from(files).filter((f) => ACCEPTED_MIME.has(f.type));
    if (validFiles.length === 0) return;
    const attachments = await Promise.all(validFiles.map(fileToAttachment));
    setImages((prev) => [...prev, ...attachments]);
  }, []);

  const removeImage = useCallback((id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  const handleSubmit = useCallback(() => {
    inputRef.current?.submit();
  }, []);

  const handleRichInputSubmit = useCallback(
    (text: string) => {
      const imgs = images.length > 0 ? images : undefined;
      onSend(text, imgs);
      setImages([]);
    },
    [images, onSend],
  );

  // Called when RichInput has empty text but user presses Enter — allow if images exist
  const handleEmptySubmitAttempt = useCallback(() => {
    if (images.length > 0) {
      onSend("", images);
      setImages([]);
      return true;
    }
    return false;
  }, [images, onSend]);

  // Allow submit with only images (no text)
  const handleSendClick = useCallback(() => {
    if (canSubmit) {
      handleSubmit();
    } else if (images.length > 0) {
      onSend("", images);
      setImages([]);
    }
  }, [canSubmit, handleSubmit, images, onSend]);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      if (e.dataTransfer.files.length > 0) {
        addFiles(e.dataTransfer.files);
      }
    },
    [addFiles],
  );

  const handlePaste = useCallback(
    (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageFiles: File[] = [];
      for (const item of items) {
        if (item.kind === "file" && ACCEPTED_MIME.has(item.type)) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        addFiles(imageFiles);
      }
    },
    [addFiles],
  );

  // Attach paste listener to the container
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener("paste", handlePaste as EventListener);
    return () => el.removeEventListener("paste", handlePaste as EventListener);
  }, [handlePaste]);

  return (
    <div className="px-4 pb-4 pt-2">
      <div
        ref={containerRef}
        className={`relative rounded-xl border bg-raised shadow-input transition-colors duration-150 focus-within:border-border-strong ${dragOver ? "border-accent border-dashed bg-accent/5" : "border-border"}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Image preview strip */}
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {images.map((img) => (
              <div key={img.id} className="group relative">
                <img
                  src={`data:${img.mimeType};base64,${img.base64}`}
                  alt=""
                  className="size-16 rounded-lg border border-border object-cover"
                />
                <button
                  type="button"
                  className="absolute -top-1.5 -right-1.5 flex size-5 cursor-pointer items-center justify-center rounded-full border border-border bg-elevated text-[0.714rem] text-text-muted opacity-0 shadow-sm transition-opacity duration-100 group-hover:opacity-100 hover:bg-hover hover:text-text"
                  onClick={() => removeImage(img.id)}
                  title="Remove image"
                >
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <path d="M1 1l6 6M7 1l-6 6" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
        <RichInput
          ref={inputRef}
          onSubmit={handleRichInputSubmit}
          onEmptySubmitAttempt={handleEmptySubmitAttempt}
          placeholder={isStreaming ? "Queue a message..." : "Send a message..."}
          mentions={mentions}
          onCanSubmitChange={setCanSubmit}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/bmp"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <div className="absolute right-2 bottom-2 flex items-center gap-1.5">
          <button
            type="button"
            className="flex size-8 cursor-pointer items-center justify-center rounded-lg border-none bg-transparent text-text-dimmed shadow-none transition-colors duration-150 hover:bg-hover hover:text-text-muted"
            onClick={() => fileInputRef.current?.click()}
            title="Attach image"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="2" width="12" height="12" rx="2" />
              <circle cx="5.5" cy="5.5" r="1" />
              <path d="M14 10.5l-3.5-3.5L4 14" />
            </svg>
          </button>
          {isStreaming && hasContent && (
            <button
              className="flex size-8 cursor-pointer items-center justify-center rounded-lg border-none shadow-none transition-all duration-150 bg-accent/15 text-accent hover:bg-accent/25"
              onClick={handleSendClick}
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
              disabled={!hasContent}
              onClick={handleSendClick}
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
});
