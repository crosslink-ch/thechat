import { useEffect, useState } from "react";

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
      className="group/copy-message inline-flex size-[28px] shrink-0 items-center justify-center border-0 bg-transparent p-0 text-text-dimmed focus-visible:outline-none"
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
        className="inline-flex size-[28px] shrink-0 items-center justify-center rounded-full transition-colors group-hover/copy-message:bg-hover group-hover/copy-message:text-text group-active/copy-message:bg-hover group-active/copy-message:text-text group-focus-visible/copy-message:ring-2 group-focus-visible/copy-message:ring-accent"
      >
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {copied ? (
            <path d="m5 12 4 4L19 6" />
          ) : (
            <>
              <rect x="8" y="8" width="12" height="12" rx="2" />
              <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
            </>
          )}
        </svg>
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
