import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatAttachment } from "@thechat/shared";
import { getAttachmentDownloadUrl } from "../lib/shared-attachments";
import { useAuthStore } from "../stores/auth";

export function SharedMessageAttachments({
  attachments,
}: {
  attachments: ChatAttachment[];
}) {
  const token = useAuthStore((state) => state.token);
  if (attachments.length === 0 || !token) return null;

  return (
    <div className="mt-2 flex max-w-2xl flex-wrap gap-2">
      {attachments.map((attachment) =>
        attachment.kind === "image" ? (
          <AuthorizedImage
            key={attachment.id}
            attachment={attachment}
            token={token}
          />
        ) : (
          <FileCard
            key={attachment.id}
            attachment={attachment}
            token={token}
          />
        ),
      )}
    </div>
  );
}

function AuthorizedImage({
  attachment,
  token,
}: {
  attachment: ChatAttachment;
  token: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const authorize = useCallback(async () => {
    if (url) return url;
    try {
      const result = await getAttachmentDownloadUrl(
        attachment.id,
        token,
        "inline",
      );
      setUrl(result.url);
      return result.url;
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Failed to load image",
      );
      return null;
    }
  }, [attachment.id, token, url]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    if (!("IntersectionObserver" in window)) {
      void authorize();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void authorize();
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [authorize]);

  const download = useCallback(async () => {
    const authorized = await getAttachmentDownloadUrl(attachment.id, token);
    window.open(authorized.url, "_blank", "noopener,noreferrer");
  }, [attachment.id, token]);

  return (
    <div ref={containerRef} className="min-h-24 min-w-32">
      {error ? (
        <button
          type="button"
          onClick={() => {
            setError(null);
            void authorize();
          }}
          className="rounded-lg border border-border bg-raised px-3 py-2 text-xs text-error-bright"
        >
          Image unavailable — retry
        </button>
      ) : url ? (
        <>
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="block overflow-hidden rounded-lg border border-border bg-raised"
            aria-label={`Open ${attachment.fileName}`}
          >
            <img
              src={url}
              alt={attachment.fileName}
              className="max-h-64 max-w-sm object-contain"
            />
          </button>
          {expanded && (
            <div
              role="dialog"
              aria-modal="true"
              aria-label={attachment.fileName}
              className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/80 p-6"
              onClick={() => setExpanded(false)}
            >
              <img
                src={url}
                alt={attachment.fileName}
                className="max-h-[85vh] max-w-[95vw] object-contain"
                onClick={(event) => event.stopPropagation()}
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void download();
                  }}
                  className="rounded bg-elevated px-3 py-2 text-sm text-text"
                >
                  Download
                </button>
                <button
                  type="button"
                  onClick={() => setExpanded(false)}
                  className="rounded bg-elevated px-3 py-2 text-sm text-text"
                >
                  Close
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <div
          role="status"
          aria-label={`Loading ${attachment.fileName}`}
          className="h-32 w-48 animate-pulse rounded-lg border border-border bg-raised"
        />
      )}
    </div>
  );
}

function FileCard({
  attachment,
  token,
}: {
  attachment: ChatAttachment;
  token: string;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const download = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getAttachmentDownloadUrl(attachment.id, token);
      window.open(result.url, "_blank", "noopener,noreferrer");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Download failed");
    } finally {
      setLoading(false);
    }
  }, [attachment.id, token]);

  return (
    <button
      type="button"
      onClick={() => void download()}
      disabled={loading}
      className="flex max-w-sm items-center gap-2 rounded-lg border border-border bg-raised px-3 py-2 text-left hover:bg-hover disabled:opacity-60"
      title={error ?? `Download ${attachment.fileName}`}
    >
      <span aria-hidden="true">📎</span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-text">
          {attachment.fileName}
        </span>
        <span className="block text-xs text-text-dimmed">
          {error ?? `${formatBytes(attachment.sizeBytes)} · ${attachment.mediaType}`}
        </span>
      </span>
    </button>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
