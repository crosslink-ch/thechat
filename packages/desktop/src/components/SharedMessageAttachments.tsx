import { useCallback, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { ChatAttachment, TraceContextCarrier } from "@thechat/shared";
import {
  getAttachmentDownloadUrl,
  openSharedAttachmentDownload,
} from "../lib/shared-attachments";
import {
  contextFromRemoteTrace,
  SpanStatusCode,
  withDesktopSpan,
} from "../lib/telemetry";
import { useAuthStore } from "../stores/auth";

const imageViewerControlClassName =
  "inline-flex size-[44px] shrink-0 cursor-pointer items-center justify-center rounded-full border border-white/20 bg-black/60 text-white shadow-lg backdrop-blur-md transition duration-150 hover:border-white/40 hover:bg-black/80 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:cursor-wait disabled:opacity-60";

function DownloadIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5" />
      <path d="M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" />
    </svg>
  );
}

function CloseIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

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
          <FileCard key={attachment.id} attachment={attachment} token={token} />
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
  const thumbnailRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const downloadInFlightRef = useRef(false);
  const renderParentRef = useRef<TraceContextCarrier | undefined>(undefined);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const authorize = useCallback(async () => {
    if (url) return url;
    renderParentRef.current = undefined;
    try {
      const result = await getAttachmentDownloadUrl(
        attachment.id,
        token,
        "inline",
      );
      renderParentRef.current = result.traceContext;
      setUrl(result.url);
      return result.url;
    } catch (caught) {
      setUrl(null);
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

  const recordImageOutcome = useCallback(
    (
      name: "attachment.image.render" | "attachment.image.open",
      outcome: "loaded" | "opened" | "failed",
      view: "thumbnail" | "expanded",
    ) => {
      void withDesktopSpan(
        name,
        {
          "thechat.attachment.image_view": view,
          "thechat.attachment.outcome": outcome,
        },
        (span) => {
          if (outcome === "failed") {
            span.setStatus({ code: SpanStatusCode.ERROR });
          }
        },
        {
          parentContext: contextFromRemoteTrace(renderParentRef.current),
          recordException: false,
        },
      );
    },
    [attachment.id],
  );

  const setViewerOpen = useCallback((open: boolean) => {
    setExpanded(open);
    setDownloadError(null);
  }, []);

  const download = useCallback(async () => {
    if (downloadInFlightRef.current) return;
    downloadInFlightRef.current = true;
    setDownloading(true);
    setDownloadError(null);
    try {
      await openSharedAttachmentDownload(
        attachment.id,
        token,
        "attachment",
        attachment.fileName,
      );
    } catch (caught) {
      setDownloadError(
        caught instanceof Error && caught.message
          ? caught.message
          : typeof caught === "string" && caught.trim()
            ? caught
            : "The attachment could not be downloaded",
      );
    } finally {
      downloadInFlightRef.current = false;
      setDownloading(false);
    }
  }, [attachment.fileName, attachment.id, token]);

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
        <Dialog.Root open={expanded} onOpenChange={setViewerOpen}>
          <Dialog.Trigger asChild>
            <button
              ref={thumbnailRef}
              type="button"
              onClick={() => {
                recordImageOutcome(
                  "attachment.image.open",
                  "opened",
                  "thumbnail",
                );
              }}
              className="block overflow-hidden rounded-lg border border-border bg-raised"
              aria-label={`Open ${attachment.fileName}`}
            >
              <img
                src={url}
                alt={attachment.fileName}
                className="max-h-64 max-w-sm object-contain"
                onLoad={() =>
                  recordImageOutcome(
                    "attachment.image.render",
                    "loaded",
                    "thumbnail",
                  )
                }
                onError={() => {
                  recordImageOutcome(
                    "attachment.image.render",
                    "failed",
                    "thumbnail",
                  );
                  renderParentRef.current = undefined;
                  setUrl(null);
                  setError("Failed to render image");
                }}
              />
            </button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm animate-fade-in" />
            <Dialog.Content
              className="fixed inset-0 z-50 flex flex-col gap-2 overflow-hidden p-2 outline-none sm:gap-4 sm:p-6"
              onClick={(event) => {
                if (event.currentTarget === event.target) setViewerOpen(false);
              }}
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                closeButtonRef.current?.focus();
              }}
              onCloseAutoFocus={(event) => {
                const thumbnail = thumbnailRef.current;
                if (thumbnail?.isConnected) {
                  event.preventDefault();
                  thumbnail.focus();
                }
              }}
            >
              <Dialog.Title className="sr-only">
                {attachment.fileName}
              </Dialog.Title>
              <Dialog.Description className="sr-only">
                Expanded image preview of {attachment.fileName}
              </Dialog.Description>
              <div
                data-testid="image-viewer-toolbar"
                className="flex h-[44px] shrink-0 items-center justify-end gap-2"
              >
                <button
                  type="button"
                  onClick={() => void download()}
                  disabled={downloading}
                  aria-busy={downloading || undefined}
                  aria-label={`Download ${attachment.fileName}`}
                  title={`Download ${attachment.fileName}`}
                  className={imageViewerControlClassName}
                >
                  <DownloadIcon
                    className={`size-5 ${downloading ? "animate-pulse" : ""}`}
                  />
                </button>
                <Dialog.Close asChild>
                  <button
                    ref={closeButtonRef}
                    type="button"
                    aria-label="Close image viewer"
                    title="Close image viewer"
                    className={imageViewerControlClassName}
                  >
                    <CloseIcon className="size-5" />
                  </button>
                </Dialog.Close>
              </div>
              <div
                data-testid="image-viewer-media"
                className="flex min-h-0 flex-1 items-center justify-center"
                onClick={(event) => {
                  if (event.currentTarget === event.target) setViewerOpen(false);
                }}
              >
                <img
                  data-testid="image-viewer-expanded-image"
                  src={url}
                  alt={attachment.fileName}
                  className="max-h-full max-w-full rounded-sm object-contain shadow-2xl"
                  onLoad={() =>
                    recordImageOutcome(
                      "attachment.image.render",
                      "loaded",
                      "expanded",
                    )
                  }
                  onError={() => {
                    recordImageOutcome(
                      "attachment.image.render",
                      "failed",
                      "expanded",
                    );
                    renderParentRef.current = undefined;
                    setViewerOpen(false);
                    setUrl(null);
                    setError("Failed to render image");
                  }}
                />
              </div>
              {downloadError && (
                <div
                  role="alert"
                  className="max-w-full shrink-0 self-center rounded-lg border border-white/20 bg-black/80 px-3 py-2 text-center text-sm text-white shadow-lg backdrop-blur-md"
                >
                  Download failed. {downloadError}
                </div>
              )}
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
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
  const [downloaded, setDownloaded] = useState(false);
  const download = useCallback(async () => {
    setLoading(true);
    setError(null);
    setDownloaded(false);
    try {
      await openSharedAttachmentDownload(
        attachment.id,
        token,
        "attachment",
        attachment.fileName,
      );
      setDownloaded(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Download failed");
    } finally {
      setLoading(false);
    }
  }, [attachment.fileName, attachment.id, token]);

  return (
    <button
      type="button"
      onClick={() => void download()}
      disabled={loading}
      className="flex max-w-sm items-center gap-2 rounded-lg border border-border bg-raised px-3 py-2 text-left hover:bg-hover disabled:opacity-60"
      title={
        error ??
        (downloaded
          ? `Downloaded ${attachment.fileName}`
          : `Download ${attachment.fileName}`)
      }
    >
      <span aria-hidden="true">📎</span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-text">
          {attachment.fileName}
        </span>
        <span className="block text-xs text-text-dimmed">
          {error ??
            (downloaded
              ? "Saved to Downloads"
              : `${formatBytes(attachment.sizeBytes)} · ${attachment.mediaType}`)}
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
