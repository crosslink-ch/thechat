import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

export function CopyMessageButton({
  text,
  onError,
}: {
  text: string;
  onError: (error: string | null) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      aria-label="Copy message"
      title={
        failed
          ? "Could not copy message. Try again."
          : copied
            ? "Copied!"
            : "Copy message"
      }
      className="group/copy-message inline-flex size-[28px] shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-text-dimmed focus-visible:outline-none"
      onClick={async () => {
        setCopied(false);
        setFailed(false);
        onError(null);
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        } catch {
          setFailed(true);
          onError("Could not copy message. Try again.");
        }
      }}
    >
      {/* Keep the visual small while mobile.css supplies a 44px touch target. */}
      <span
        data-copy-message-visual
        className="inline-flex size-[28px] shrink-0 items-center justify-center rounded-full transition-colors duration-150 group-hover/copy-message:bg-hover group-hover/copy-message:text-text group-active/copy-message:bg-hover group-active/copy-message:text-text group-focus-visible/copy-message:ring-2 group-focus-visible/copy-message:ring-accent"
      >
        {copied ? (
          <Check size={16} className="text-success" aria-hidden="true" />
        ) : (
          <Copy size={16} aria-hidden="true" />
        )}
      </span>
      <span
        role={copied ? "status" : undefined}
        aria-live="polite"
        className="sr-only"
      >
        {copied ? "Message copied" : ""}
      </span>
    </button>
  );
}
