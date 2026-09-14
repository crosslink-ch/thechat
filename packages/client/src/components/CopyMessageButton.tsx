import { useEffect, useState } from "react";

export function CopyMessageButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <>
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
        className="inline-flex size-7 items-center justify-center rounded-full border border-border-subtle bg-transparent text-text-dimmed transition-colors hover:border-border hover:bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        onClick={async () => {
          setCopied(false);
          setFailed(false);
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
          } catch {
            setFailed(true);
          }
        }}
      >
        <svg
          viewBox="0 0 24 24"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
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
        <span role={copied ? "status" : undefined} aria-live="polite" className="sr-only">
          {copied ? "Message copied" : ""}
        </span>
      </button>
      {failed && (
        <span
          role="alert"
          className="absolute right-0 top-full z-10 mt-1 w-max max-w-[min(18rem,80vw)] rounded border border-border bg-elevated px-2 py-1 text-xs text-error-bright"
        >
          Could not copy message. Try again.
        </span>
      )}
    </>
  );
}
