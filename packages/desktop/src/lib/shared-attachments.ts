import type { AttachmentView } from "@thechat/shared";
import { api } from "./api";
import { authHeaders, edenErrorMessage } from "./eden";

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
  update({ phase: "hashing", progress: 0 });
  const checksumSha256 = await sha256Hex(await input.file.arrayBuffer());
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
  const reserved = await root.post(
    {
      conversationId: input.conversationId,
      fileName: input.file.name,
      mediaType: input.file.type,
      sizeBytes: input.file.size,
      checksumSha256,
    },
    authHeaders(input.token),
  );
  if (reserved.error || !reserved.data) {
    throw new Error(
      edenErrorMessage(reserved.error, "Failed to reserve attachment"),
    );
  }
  const attachment = reserved.data.attachment;
  update({ phase: "uploading", progress: 0, attachment });

  await putPresignedObject(
    reserved.data.upload.url,
    reserved.data.upload.headers,
    input.file,
    input.signal,
    (progress) =>
      update({ phase: "uploading", progress, attachment }),
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
  const completed = await item.complete.post({}, authHeaders(input.token));
  if (completed.error || !completed.data) {
    throw new Error(
      edenErrorMessage(completed.error, "Failed to complete attachment"),
    );
  }
  update({ phase: "processing", progress: 100, attachment: completed.data });

  for (let attempt = 0; attempt < 180; attempt += 1) {
    throwIfAborted(input.signal);
    const status = await item.get(authHeaders(input.token));
    if (status.error || !status.data) {
      throw new Error(
        edenErrorMessage(status.error, "Failed to check attachment status"),
      );
    }
    if (status.data.status === "ready" || status.data.status === "attached") {
      update({ phase: "ready", progress: 100, attachment: status.data });
      return status.data;
    }
    if (
      status.data.status === "rejected" ||
      status.data.status === "deleting" ||
      status.data.status === "deleted"
    ) {
      throw new Error("The attachment was rejected during validation");
    }
    await abortableDelay(1_000, input.signal);
  }
  throw new Error("Attachment validation timed out");
}

export async function cancelSharedAttachment(
  attachmentId: string,
  token: string,
) {
  const item = api.attachments({ id: attachmentId }) as unknown as {
    delete(
      options: ReturnType<typeof authHeaders>,
    ): Promise<{ data?: unknown; error?: unknown }>;
  };
  const result = await item.delete(authHeaders(token));
  if (result.error) {
    throw new Error(
      edenErrorMessage(result.error, "Failed to cancel attachment"),
    );
  }
}

export async function getAttachmentDownloadUrl(
  attachmentId: string,
  token: string,
  disposition: "attachment" | "inline" = "attachment",
) {
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
    ...authHeaders(token),
    query: { disposition },
  });
  if (result.error || !result.data) {
    throw new Error(
      edenErrorMessage(result.error, "Failed to authorize attachment"),
    );
  }
  return result.data;
}

function putPresignedObject(
  url: string,
  headers: Record<string, string>,
  file: File,
  signal: AbortSignal,
  onProgress: (progress: number) => void,
) {
  return new Promise<void>((resolve, reject) => {
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
    xhr.onabort = () => finish(new DOMException("Upload cancelled", "AbortError"));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) finish();
      else finish(new Error(`Object-store upload failed (${xhr.status})`));
    };
    xhr.send(file);

    function finish(error?: Error) {
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    }
  });
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
