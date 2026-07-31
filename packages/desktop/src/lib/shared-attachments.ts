import type { AttachmentView } from "@thechat/shared";
import type { Context, Span } from "@opentelemetry/api";
import { invoke } from "@tauri-apps/api/core";
import { api } from "./api";
import { authHeaders, edenErrorMessage, edenErrorStatus } from "./eden";
import {
  SpanKind,
  SpanStatusCode,
  recordSanitizedException,
  traceContextCarrier,
  traceHeaders,
  withDesktopSpan,
} from "./telemetry";

export const SHARED_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const SHARED_ATTACHMENT_MAX_COUNT = 10;

export const SHARED_ATTACHMENT_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/json",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "video/mp4",
  "video/webm",
]);

export type SharedAttachmentPhase =
  | "queued"
  | "hashing"
  | "uploading"
  | "processing"
  | "cancelling"
  | "ready"
  | "error";

export interface SharedAttachmentDraft {
  localId: string;
  file: File;
  previewUrl: string | null;
  phase: SharedAttachmentPhase;
  progress: number;
  attachment: AttachmentView | null;
  error: string | null;
}

export async function uploadSharedAttachment(
  input: {
    conversationId: string;
    token: string;
    file: File;
    signal: AbortSignal;
  },
  update: (value: {
    phase: SharedAttachmentPhase;
    progress: number;
    attachment?: AttachmentView;
  }) => void,
): Promise<AttachmentView> {
  return withDesktopSpan(
    "attachment.prepare",
    {
      "thechat.attachment.media_type": input.file.type,
      "thechat.attachment.size_bytes": input.file.size,
    },
    async (flowSpan, flowContext) => {
      update({ phase: "hashing", progress: 0 });
      const checksumSha256 = await withDesktopSpan(
        "attachment.hash",
        { "thechat.attachment.size_bytes": input.file.size },
        async () => sha256Hex(await input.file.arrayBuffer()),
        { parentContext: flowContext },
      );
      throwIfAborted(input.signal);

      const root = api.attachments as unknown as {
        post(
          body: {
            conversationId: string;
            fileName: string;
            mediaType: string;
            sizeBytes: number;
            checksumSha256: string;
          },
          options: ReturnType<typeof authHeaders>,
        ): Promise<{
          data?: {
            attachment: AttachmentView;
            upload: {
              method: "PUT";
              url: string;
              headers: Record<string, string>;
              expiresAt: string;
            };
          } | null;
          error?: unknown;
        }>;
      };
      const reserved = await withDesktopSpan(
        "attachment.reserve.request",
        {
          "http.request.method": "POST",
          "http.route": "/attachments",
        },
        async (span, requestContext) => {
          const result = await root.post(
            {
              conversationId: input.conversationId,
              fileName: input.file.name,
              mediaType: input.file.type,
              sizeBytes: input.file.size,
              checksumSha256,
            },
            authHeaders(input.token, traceHeaders(requestContext)),
          );
          if (result.error || !result.data) {
            markClientFailure(span, result.error, "reserve_failed");
            throw new Error(
              edenErrorMessage(result.error, "Failed to reserve attachment"),
            );
          }
          span.setAttribute("http.response.status_code", 200);
          span.setAttribute("thechat.attachment.outcome", "reserved");
          return result.data;
        },
        { kind: SpanKind.CLIENT, parentContext: flowContext },
      );
      const attachment = reserved.attachment;
      const upload = reserved.upload;
      try {
        throwIfAborted(input.signal);
        update({ phase: "uploading", progress: 0, attachment });

        await withDesktopSpan(
          "attachment.s3.upload",
          {
            "http.request.method": "PUT",
            "server.address": "s3",
            "thechat.attachment.size_bytes": input.file.size,
          },
          async (span) => {
            try {
              const status = await putPresignedObject(
                upload.url,
                upload.headers,
                input.file,
                input.signal,
                (progress) =>
                  update({ phase: "uploading", progress, attachment }),
              );
              span.setAttribute("http.response.status_code", status);
              span.setAttribute("thechat.attachment.outcome", "uploaded");
            } catch (error) {
              if (error instanceof ObjectStoreTransferError && error.status) {
                span.setAttribute("http.response.status_code", error.status);
              }
              span.setAttribute(
                "thechat.attachment.outcome",
                error instanceof DOMException && error.name === "AbortError"
                  ? "cancelled"
                  : "upload_failed",
              );
              throw error;
            }
          },
          { kind: SpanKind.CLIENT, parentContext: flowContext },
        );
        throwIfAborted(input.signal);

        const item = api.attachments({ id: attachment.id }) as unknown as {
          complete: {
            post(
              body: Record<string, never>,
              options: ReturnType<typeof authHeaders>,
            ): Promise<{ data?: AttachmentView | null; error?: unknown }>;
          };
          get(
            options: ReturnType<typeof authHeaders>,
          ): Promise<{ data?: AttachmentView | null; error?: unknown }>;
        };
        const completed = await withDesktopSpan(
          "attachment.complete.request",
          {
            "http.request.method": "POST",
            "http.route": "/attachments/:id/complete",
          },
          async (span, requestContext) => {
            const result = await item.complete.post(
              {},
              authHeaders(input.token, traceHeaders(requestContext)),
            );
            if (result.error || !result.data) {
              markClientFailure(span, result.error, "complete_failed");
              throw new Error(
                edenErrorMessage(result.error, "Failed to complete attachment"),
              );
            }
            span.setAttribute("http.response.status_code", 200);
            span.setAttribute("thechat.attachment.outcome", "completed");
            return result.data;
          },
          { kind: SpanKind.CLIENT, parentContext: flowContext },
        );
        update({ phase: "processing", progress: 100, attachment: completed });

        const validation = await withDesktopSpan(
          "attachment.validation.wait",
          {},
          async (span, waitContext) => {
            for (let attempt = 0; attempt < 180; attempt += 1) {
              throwIfAborted(input.signal);
              const status = await withDesktopSpan(
                "attachment.status.request",
                {
                  "http.request.method": "GET",
                  "http.route": "/attachments/:id",
                  "thechat.attachment.poll_attempt": attempt + 1,
                },
                async (requestSpan, requestContext) => {
                  const result = await item.get(
                    authHeaders(input.token, traceHeaders(requestContext)),
                  );
                  if (result.error || !result.data) {
                    markClientFailure(
                      requestSpan,
                      result.error,
                      "status_failed",
                    );
                    throw new Error(
                      edenErrorMessage(
                        result.error,
                        "Failed to check attachment status",
                      ),
                    );
                  }
                  requestSpan.setAttribute("http.response.status_code", 200);
                  requestSpan.setAttribute(
                    "thechat.attachment.status",
                    result.data.status ?? "unknown",
                  );
                  requestSpan.setAttribute(
                    "thechat.attachment.outcome",
                    "loaded",
                  );
                  return result.data;
                },
                { kind: SpanKind.CLIENT, parentContext: waitContext },
              );
              span.setAttribute(
                "thechat.attachment.poll_attempts",
                attempt + 1,
              );
              if (status.status) {
                span.setAttribute("thechat.attachment.status", status.status);
              }
              if (status.status === "ready" || status.status === "attached") {
                span.setAttribute("thechat.attachment.outcome", "ready");
                return { kind: "ready" as const, attachment: status };
              }
              if (
                status.status === "rejected" ||
                status.status === "deleting" ||
                status.status === "deleted"
              ) {
                span.setAttribute("thechat.attachment.outcome", "rejected");
                return { kind: "rejected" as const, attachment: status };
              }
              await abortableDelay(1_000, input.signal);
            }
            const timeoutError = new Error("Attachment validation timed out");
            span.setAttribute("thechat.attachment.outcome", "timed_out");
            recordSanitizedException(span, timeoutError);
            throw timeoutError;
          },
          { parentContext: flowContext, recordException: false },
        );
        if (validation.kind === "rejected") {
          flowSpan.setAttribute("thechat.attachment.outcome", "rejected");
          throw new Error("The attachment was rejected during validation");
        }
        const ready = validation.attachment;
        update({ phase: "ready", progress: 100, attachment: ready });
        flowSpan.setAttribute("thechat.attachment.outcome", "ready");
        return ready;
      } catch (error) {
        if (input.signal.aborted) {
          flowSpan.setAttribute("thechat.attachment.outcome", "cancelled");
          await cancelSharedAttachment(attachment.id, input.token, {
            parentContext: flowContext,
          });
        }
        throw error;
      }
    },
    { recordException: false },
  );
}

export async function cancelSharedAttachment(
  attachmentId: string,
  token: string,
  options: { parentContext?: Context } = {},
) {
  return withDesktopSpan(
    "attachment.cancel.request",
    {
      "http.request.method": "DELETE",
      "http.route": "/attachments/:id",
    },
    async (span, requestContext) => {
      const item = api.attachments({ id: attachmentId }) as unknown as {
        delete(
          body: undefined,
          options: ReturnType<typeof authHeaders>,
        ): Promise<{ data?: unknown; error?: unknown }>;
      };
      const result = await item.delete(
        undefined,
        authHeaders(token, traceHeaders(requestContext)),
      );
      if (result.error) {
        markClientFailure(span, result.error, "cancellation_failed");
        throw new Error(
          edenErrorMessage(result.error, "Failed to cancel attachment"),
        );
      }
      span.setAttribute("http.response.status_code", 200);
      span.setAttribute(
        "thechat.attachment.outcome",
        "cancellation_requested",
      );
    },
    { kind: SpanKind.CLIENT, parentContext: options.parentContext },
  );
}

export async function getAttachmentDownloadUrl(
  attachmentId: string,
  token: string,
  disposition: "attachment" | "inline" = "attachment",
  options: { parentContext?: Context } = {},
) {
  return withDesktopSpan(
    "attachment.download.authorize.request",
    {
      "http.request.method": "GET",
      "http.route": "/attachments/:id/download",
      "thechat.attachment.disposition": disposition,
    },
    async (span, requestContext) => {
      const item = api.attachments({ id: attachmentId }) as unknown as {
        download: {
          get(
            options: ReturnType<typeof authHeaders> & {
              query: { disposition: "attachment" | "inline" };
            },
          ): Promise<{
            data?: { url: string; expiresAt: string } | null;
            error?: unknown;
          }>;
        };
      };
      const result = await item.download.get({
        ...authHeaders(token, traceHeaders(requestContext)),
        query: { disposition },
      });
      if (result.error || !result.data) {
        markClientFailure(span, result.error, "authorization_failed");
        throw new Error(
          edenErrorMessage(result.error, "Failed to authorize attachment"),
        );
      }
      span.setAttribute("http.response.status_code", 200);
      span.setAttribute("thechat.attachment.outcome", "authorized");
      const traceContext = traceContextCarrier(requestContext);
      return {
        ...result.data,
        ...(traceContext ? { traceContext } : {}),
      };
    },
    { kind: SpanKind.CLIENT, parentContext: options.parentContext },
  );
}

export async function openSharedAttachmentDownload(
  attachmentId: string,
  token: string,
  disposition: "attachment" | "inline" = "attachment",
  suggestedFileName?: string,
) {
  return withDesktopSpan(
    "attachment.download",
    {
      "thechat.attachment.disposition": disposition,
    },
    async (span, downloadContext) => {
      const result = await getAttachmentDownloadUrl(
        attachmentId,
        token,
        disposition,
        { parentContext: downloadContext },
      );
      const transfer = await withDesktopSpan(
        "attachment.s3.download",
        {
          "http.request.method": "GET",
          "server.address": "s3",
        },
        async (transferSpan) => {
          try {
            if (isTauriRuntime()) {
              const native = await invoke<NativeAttachmentDownload>(
                "download_attachment_to_file",
                {
                  url: result.url,
                  suggestedFileName,
                },
              );
              if (
                native.httpStatus !== 200 ||
                !native.savedPath ||
                !Number.isSafeInteger(native.transferredBytes) ||
                native.transferredBytes <= 0
              ) {
                throw new Error("Native attachment download returned invalid evidence");
              }
              transferSpan.setAttribute(
                "http.response.status_code",
                native.httpStatus,
              );
              transferSpan.setAttribute(
                "thechat.attachment.transferred_bytes",
                native.transferredBytes,
              );
              transferSpan.setAttribute(
                "thechat.attachment.outcome",
                "downloaded",
              );
              return {
                kind: "native" as const,
                savedPath: native.savedPath,
                transferredBytes: native.transferredBytes,
              };
            }

            const response = await fetch(result.url, { method: "GET" });
            transferSpan.setAttribute(
              "http.response.status_code",
              response.status,
            );
            if (!response.ok) {
              throw new ObjectStoreTransferError(
                "Object-store download failed",
                response.status,
              );
            }
            const blob = await response.blob();
            transferSpan.setAttribute(
              "thechat.attachment.transferred_bytes",
              blob.size,
            );
            transferSpan.setAttribute(
              "thechat.attachment.outcome",
              "downloaded",
            );
            return {
              kind: "browser" as const,
              blob,
              transferredBytes: blob.size,
            };
          } catch (error) {
            if (error instanceof ObjectStoreTransferError && error.status) {
              transferSpan.setAttribute(
                "http.response.status_code",
                error.status,
              );
            }
            transferSpan.setAttribute(
              "thechat.attachment.outcome",
              "transfer_failed",
            );
            throw error;
          }
        },
        { kind: SpanKind.CLIENT, parentContext: downloadContext },
      );
      span.addEvent("attachment.download.transfer_completed");
      span.setAttribute("thechat.attachment.transfer_observed", true);
      span.setAttribute(
        "thechat.attachment.transferred_bytes",
        transfer.transferredBytes,
      );
      try {
        if (transfer.kind === "native") {
          span.setAttribute("thechat.attachment.handoff", "native_opener");
          span.addEvent("attachment.download.shell_handoff_completed");
        } else {
          launchDownloadedBlob(
            transfer.blob,
            disposition,
            suggestedFileName,
          );
          span.setAttribute("thechat.attachment.handoff", "browser_download");
        }
      } catch (error) {
        span.setAttribute("thechat.attachment.outcome", "launch_failed");
        recordSanitizedException(span, error);
        throw error;
      }
      span.setAttribute("thechat.attachment.outcome", "completed");
      return {
        expiresAt: result.expiresAt,
        transferredBytes: transfer.transferredBytes,
      };
    },
    { recordException: false },
  );
}

interface NativeAttachmentDownload {
  savedPath: string;
  transferredBytes: number;
  httpStatus: number;
}

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

function putPresignedObject(
  url: string,
  headers: Record<string, string>,
  file: File,
  signal: AbortSignal,
  onProgress: (progress: number) => void,
) {
  return new Promise<number>((resolve, reject) => {
    try {
      throwIfAborted(signal);
    } catch (error) {
      reject(error);
      return;
    }
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    signal.addEventListener("abort", abort, { once: true });
    xhr.open("PUT", url);
    for (const [name, value] of Object.entries(headers)) {
      xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onerror = () => finish(new Error("Object-store upload failed"));
    xhr.onabort = () =>
      finish(new DOMException("Upload cancelled", "AbortError"));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        finish(undefined, xhr.status);
      } else {
        finish(
          new ObjectStoreTransferError(
            "Object-store upload failed",
            xhr.status,
          ),
        );
      }
    };
    xhr.send(file);

    function finish(error?: Error, status = 0) {
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(status);
    }
  });
}

class ObjectStoreTransferError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ObjectStoreTransferError";
  }
}

function markClientFailure(span: Span, error: unknown, outcome: string) {
  const status =
    error instanceof ObjectStoreTransferError
      ? error.status
      : edenErrorStatus(error);
  if (status) {
    span.setAttribute("http.response.status_code", status);
  }
  span.setAttribute("thechat.attachment.outcome", outcome);
  span.setStatus({ code: SpanStatusCode.ERROR });
}

function launchDownloadedBlob(
  blob: Blob,
  disposition: "attachment" | "inline",
  suggestedFileName?: string,
) {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.rel = "noopener noreferrer";
  if (disposition === "attachment") {
    anchor.download = suggestedFileName || "attachment";
  } else {
    anchor.target = "_blank";
  }
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

async function sha256Hex(buffer: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function abortableDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(done, ms);
    signal.addEventListener("abort", abort, { once: true });
    function done() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timeout);
      reject(new DOMException("Upload cancelled", "AbortError"));
    }
  });
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw new DOMException("Upload cancelled", "AbortError");
  }
}
