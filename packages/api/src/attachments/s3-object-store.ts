import {
  ChecksumAlgorithm,
  ChecksumMode,
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type CopyObjectCommandOutput,
  type DeleteObjectCommandOutput,
  type GetObjectCommandOutput,
  type HeadObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SpanKind } from "@opentelemetry/api";
import { withSpan } from "../observability";
import type {
  ObjectStore,
  PresignedRequest,
  StoredObjectMetadata,
} from "./object-store";

type ServerCommand =
  | HeadObjectCommand
  | GetObjectCommand
  | CopyObjectCommand
  | DeleteObjectCommand;

const STORAGE_FAILURE_ATTRIBUTES = {
  "thechat.storage.outcome": "failed",
} as const;

/**
 * Network deadlines for server-side S3 calls. None of them limits how long a
 * transfer that keeps making progress may take; they only detect a connection
 * or response that has stopped. The overall bound is the caller's abort signal
 * (the outbox attempt budget in the worker).
 */
export interface S3TimeoutOptions {
  /** TCP/TLS connect. */
  connectTimeoutMs: number;
  /** From sending a request until S3's response headers arrive. */
  responseTimeoutMs: number;
  /** Longest gap between two chunks while streaming an object body. */
  bodyIdleTimeoutMs: number;
}

export const DEFAULT_S3_TIMEOUTS: S3TimeoutOptions = {
  connectTimeoutMs: 10_000,
  responseTimeoutMs: 30_000,
  bodyIdleTimeoutMs: 30_000,
};

export class S3BodyIdleTimeoutError extends Error {
  constructor(public readonly idleMs: number) {
    super(`S3 object body sent no data for ${idleMs} ms`);
    this.name = "S3BodyIdleTimeoutError";
  }
}

export interface S3ObjectStoreOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  /** Optional browser-reachable S3 origin. Server/worker I/O stays on endpoint. */
  publicEndpoint?: string;
  forcePathStyle?: boolean;
  timeouts?: Partial<S3TimeoutOptions>;
  client?: S3Client;
}

export class S3ObjectStore implements ObjectStore {
  private readonly bucket: string;
  private readonly region: string;
  private readonly client: S3Client;
  private readonly signingClient: S3Client;
  private readonly timeouts: S3TimeoutOptions;

  constructor(options: S3ObjectStoreOptions) {
    if (options.publicEndpoint) {
      let endpoint: URL;
      try {
        endpoint = new URL(options.publicEndpoint);
      } catch {
        throw new Error("ATTACHMENT_S3_PUBLIC_ENDPOINT must be a valid origin");
      }
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
      if (
        (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) ||
        endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/"
      ) {
        throw new Error("ATTACHMENT_S3_PUBLIC_ENDPOINT must be an HTTPS origin (HTTP only on loopback)");
      }
    }
    if (!options.bucket.trim()) {
      throw new Error("ATTACHMENT_S3_BUCKET is required");
    }
    if (!options.region.trim()) {
      throw new Error("ATTACHMENT_S3_REGION is required");
    }
    this.bucket = options.bucket;
    this.region = options.region;
    this.timeouts = { ...DEFAULT_S3_TIMEOUTS, ...options.timeouts };
    this.client =
      options.client ??
      new S3Client({
        region: options.region,
        ...(options.endpoint ? { endpoint: options.endpoint } : {}),
        forcePathStyle: options.forcePathStyle ?? false,
        // Without these the SDK waits forever on a dead connection. Under Bun,
        // socketTimeout is not enforced; requestTimeout with
        // throwOnRequestTimeout bounds the wait for response headers, and
        // getObject enforces its own body idle timeout below.
        requestHandler: {
          connectionTimeout: this.timeouts.connectTimeoutMs,
          requestTimeout: this.timeouts.responseTimeoutMs,
          throwOnRequestTimeout: true,
        },
        // Credentials intentionally come from the AWS SDK default chain.
      });
    this.signingClient = options.publicEndpoint
      ? new S3Client({
          region: options.region,
          endpoint: options.publicEndpoint,
          credentials: this.client.config.credentials,
          forcePathStyle: options.forcePathStyle ?? false,
        })
      : this.client;
  }

  async createUploadRequest(input: {
    key: string;
    mediaType: string;
    sizeBytes: number;
    checksumSha256Base64: string;
    expiresInSeconds: number;
  }): Promise<PresignedRequest> {
    return withSpan(
      "attachment.s3.presign_upload",
      this.s3Attributes("PutObject"),
      async (span) => {
        const command = new PutObjectCommand({
          Bucket: this.bucket,
          Key: input.key,
          ContentType: input.mediaType,
          ContentLength: input.sizeBytes,
          IfNoneMatch: "*",
          ChecksumAlgorithm: ChecksumAlgorithm.SHA256,
          ChecksumSHA256: input.checksumSha256Base64,
        });
        const url = await getSignedUrl(this.signingClient, command, {
          expiresIn: input.expiresInSeconds,
          unhoistableHeaders: new Set([
            "x-amz-checksum-sha256",
            "if-none-match",
          ]),
        });
        span.setAttribute("thechat.storage.outcome", "presigned");
        span.setAttribute("thechat.attachment.size_bytes", input.sizeBytes);
        span.setAttribute("thechat.capability.ttl_seconds", input.expiresInSeconds);
        return {
          method: "PUT",
          url,
          headers: {
            "content-type": input.mediaType,
            "if-none-match": "*",
            "x-amz-checksum-sha256": input.checksumSha256Base64,
          },
          expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
        };
      },
      { errorAttributes: STORAGE_FAILURE_ATTRIBUTES },
    );
  }

  async headObject(input: {
    key: string;
    versionId?: string;
    signal?: AbortSignal;
  }): Promise<StoredObjectMetadata | null> {
    return withSpan(
      "attachment.s3.head",
      this.s3Attributes("HeadObject", Boolean(input.versionId)),
      async (span) => {
        try {
          const output = await this.send<HeadObjectCommandOutput>(
            new HeadObjectCommand({
              Bucket: this.bucket,
              Key: input.key,
              ...(input.versionId ? { VersionId: input.versionId } : {}),
              ChecksumMode: ChecksumMode.ENABLED,
            }),
            input.signal,
          );
          span.setAttribute("thechat.storage.outcome", "found");
          span.setAttribute("thechat.attachment.size_bytes", output.ContentLength ?? -1);
          return {
            versionId: output.VersionId ?? null,
            sizeBytes: output.ContentLength ?? -1,
            checksumSha256Base64: output.ChecksumSHA256 ?? null,
            contentType: output.ContentType ?? null,
          };
        } catch (error) {
          if (isNotFound(error)) {
            span.setAttribute("thechat.storage.outcome", "not_found");
            return null;
          }
          throw error;
        }
      },
      { kind: SpanKind.CLIENT, errorAttributes: STORAGE_FAILURE_ATTRIBUTES },
    );
  }

  async getObject(input: {
    key: string;
    versionId: string;
    maxBytes: number;
    signal?: AbortSignal;
  }): Promise<Uint8Array> {
    return withSpan(
      "attachment.s3.get",
      this.s3Attributes("GetObject", true),
      async (span) => {
        const output = await this.send<GetObjectCommandOutput>(
          new GetObjectCommand({
            Bucket: this.bucket,
            Key: input.key,
            VersionId: input.versionId,
            ChecksumMode: ChecksumMode.ENABLED,
          }),
          input.signal,
        );
        if (!output.Body) throw new Error("S3 object has no body");

        const chunks: Uint8Array[] = [];
        let total = 0;
        const body = output.Body as AsyncIterable<Uint8Array>;
        const guard = guardBodyStream(
          body,
          this.timeouts.bodyIdleTimeoutMs,
          input.signal,
        );
        try {
          for await (const rawChunk of body) {
            guard.progress();
            const chunk =
              rawChunk instanceof Uint8Array
                ? rawChunk
                : new Uint8Array(rawChunk as ArrayBuffer);
            total += chunk.byteLength;
            if (total > input.maxBytes) {
              span.setAttribute(
                "thechat.storage.failure_reason",
                "size_limit_exceeded",
              );
              throw new Error("Stored object exceeds the configured attachment limit");
            }
            chunks.push(chunk);
          }
        } catch (error) {
          const interruption = guard.interruption();
          if (interruption instanceof S3BodyIdleTimeoutError) {
            span.setAttribute("thechat.storage.failure_reason", "body_idle_timeout");
          }
          throw interruption ?? error;
        } finally {
          guard.dispose();
        }
        const result = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.byteLength;
        }
        span.setAttribute("thechat.storage.outcome", "read");
        span.setAttribute("thechat.attachment.size_bytes", total);
        return result;
      },
      { kind: SpanKind.CLIENT, errorAttributes: STORAGE_FAILURE_ATTRIBUTES },
    );
  }

  async copyObject(input: {
    sourceKey: string;
    sourceVersionId: string;
    destinationKey: string;
    mediaType: string;
    signal?: AbortSignal;
  }): Promise<{ versionId: string | null }> {
    return withSpan(
      "attachment.s3.copy",
      this.s3Attributes("CopyObject", true),
      async (span) => {
        const source = `${encodeS3Path(this.bucket)}/${encodeS3Path(
          input.sourceKey,
        )}?versionId=${encodeURIComponent(input.sourceVersionId)}`;
        const output = await this.send<CopyObjectCommandOutput>(
          new CopyObjectCommand({
            Bucket: this.bucket,
            Key: input.destinationKey,
            CopySource: source,
            ContentType: input.mediaType,
            MetadataDirective: "REPLACE",
            TaggingDirective: "REPLACE",
            ChecksumAlgorithm: "SHA256",
          }),
          input.signal,
        );
        span.setAttribute("thechat.storage.outcome", "copied");
        return { versionId: output.VersionId ?? null };
      },
      { kind: SpanKind.CLIENT, errorAttributes: STORAGE_FAILURE_ATTRIBUTES },
    );
  }

  async deleteObject(input: {
    key: string;
    versionId?: string | null;
    signal?: AbortSignal;
  }): Promise<void> {
    await withSpan(
      "attachment.s3.delete",
      this.s3Attributes("DeleteObject", Boolean(input.versionId)),
      async (span) => {
        await this.send<DeleteObjectCommandOutput>(
          new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: input.key,
            ...(input.versionId ? { VersionId: input.versionId } : {}),
          }),
          input.signal,
        );
        span.setAttribute("thechat.storage.outcome", "deleted");
      },
      { kind: SpanKind.CLIENT, errorAttributes: STORAGE_FAILURE_ATTRIBUTES },
    );
  }

  async createDownloadRequest(input: {
    key: string;
    versionId: string;
    mediaType: string;
    contentDisposition: string;
    expiresInSeconds: number;
  }): Promise<PresignedRequest> {
    return withSpan(
      "attachment.s3.presign_download",
      this.s3Attributes("GetObject", true),
      async (span) => {
        const url = await getSignedUrl(
          this.signingClient,
          new GetObjectCommand({
            Bucket: this.bucket,
            Key: input.key,
            VersionId: input.versionId,
            ResponseContentType: input.mediaType,
            ResponseContentDisposition: input.contentDisposition,
          }),
          { expiresIn: input.expiresInSeconds },
        );
        span.setAttribute("thechat.storage.outcome", "presigned");
        span.setAttribute("thechat.capability.ttl_seconds", input.expiresInSeconds);
        return {
          method: "GET",
          url,
          headers: {},
          expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
        };
      },
      { errorAttributes: STORAGE_FAILURE_ATTRIBUTES },
    );
  }

  /**
   * Send a server-side command. With a signal, the call rejects as soon as the
   * signal aborts, even when S3 stalls after sending response headers: under
   * Bun the SDK's own abort handling does not interrupt a body it is still
   * collecting (CopyObject/DeleteObject XML), so the stalled body is destroyed
   * to free its socket and the caller is released explicitly.
   */
  private async send<TOutput>(
    command: ServerCommand,
    signal: AbortSignal | undefined,
  ): Promise<TOutput> {
    const client = this.client as unknown as {
      send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
    };
    if (!signal) {
      return (await client.send(command)) as TOutput;
    }
    signal.throwIfAborted();
    (
      command.middlewareStack as unknown as {
        add(middleware: unknown, options: Record<string, unknown>): void;
      }
    ).add(destroyBodyOnAbort(signal), {
      step: "finalizeRequest",
      priority: "low",
      name: "thechatDestroyBodyOnAbort",
    });
    return (await raceAbort(
      client.send(command, { abortSignal: signal }),
      signal,
    )) as TOutput;
  }

  private s3Attributes(operation: string, exactVersion = false) {
    return {
      "rpc.system": "aws-api",
      "rpc.service": "S3",
      "rpc.method": operation,
      "cloud.region": this.region,
      "thechat.storage.exact_version": exactVersion,
    };
  }
}

export function createS3ObjectStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): S3ObjectStore {
  return new S3ObjectStore({
    bucket: env.ATTACHMENT_S3_BUCKET?.trim() ?? "",
    region: env.ATTACHMENT_S3_REGION?.trim() ?? "",
    endpoint: env.ATTACHMENT_S3_ENDPOINT?.trim() || undefined,
    publicEndpoint: env.ATTACHMENT_S3_PUBLIC_ENDPOINT?.trim() || undefined,
    forcePathStyle: env.ATTACHMENT_S3_FORCE_PATH_STYLE === "true",
    timeouts: loadS3TimeoutOptions(env),
  });
}

export function loadS3TimeoutOptions(
  env: NodeJS.ProcessEnv = process.env,
): S3TimeoutOptions {
  return {
    connectTimeoutMs: positiveInteger(
      env.ATTACHMENT_S3_CONNECT_TIMEOUT_MS,
      DEFAULT_S3_TIMEOUTS.connectTimeoutMs,
    ),
    responseTimeoutMs: positiveInteger(
      env.ATTACHMENT_S3_RESPONSE_TIMEOUT_MS,
      DEFAULT_S3_TIMEOUTS.responseTimeoutMs,
    ),
    bodyIdleTimeoutMs: positiveInteger(
      env.ATTACHMENT_S3_BODY_IDLE_TIMEOUT_MS,
      DEFAULT_S3_TIMEOUTS.bodyIdleTimeoutMs,
    ),
  };
}

/** Reject with the signal's reason once it aborts; never leaves `work` unhandled. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * finalizeRequest middleware: sees the raw HTTP response before the SDK reads
 * its body, and destroys that body if the signal aborts while it is read.
 */
function destroyBodyOnAbort(signal: AbortSignal) {
  return (next: (args: unknown) => Promise<{ response?: { body?: unknown } }>) =>
    async (args: unknown) => {
      const result = await next(args);
      const body = result.response?.body as
        | (DestroyableStream & {
            once?: (event: string, listener: () => void) => void;
          })
        | undefined;
      if (body && typeof body.destroy === "function") {
        const onAbort = () => body.destroy?.(abortReason(signal));
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
          body.once?.("close", () => signal.removeEventListener("abort", onAbort));
        }
      }
      return result;
    };
}

interface DestroyableStream {
  destroy?: (error?: Error) => void;
}

/**
 * Once S3 has sent response headers, neither the SDK's request timeout nor its
 * abort signal interrupts a body that stops sending data (verified under Bun).
 * Destroying the stream does, so do that when the body goes idle for too long
 * or the caller aborts.
 */
function guardBodyStream(
  body: AsyncIterable<Uint8Array>,
  idleTimeoutMs: number,
  signal: AbortSignal | undefined,
) {
  const stream = body as unknown as DestroyableStream;
  let interruption: Error | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const interrupt = (error: Error) => {
    if (interruption) return;
    interruption = error;
    clearTimeout(idleTimer);
    stream.destroy?.(error);
  };
  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => interrupt(new S3BodyIdleTimeoutError(idleTimeoutMs)),
      idleTimeoutMs,
    );
  };
  const onAbort = () => interrupt(abortReason(signal));

  armIdleTimer();
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  return {
    progress: armIdleTimer,
    interruption: () => interruption,
    dispose() {
      clearTimeout(idleTimer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("S3 object read was aborted");
  error.name = "AbortError";
  return error;
}

function positiveInteger(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function encodeS3Path(value: string) {
  return value
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function isNotFound(error: unknown) {
  const candidate = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate?.name === "NotFound" ||
    candidate?.name === "NoSuchKey" ||
    candidate?.$metadata?.httpStatusCode === 404
  );
}
