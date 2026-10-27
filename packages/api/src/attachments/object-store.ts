export interface StoredObjectMetadata {
  versionId: string | null;
  sizeBytes: number;
  checksumSha256Base64: string | null;
  contentType: string | null;
}

export interface PresignedRequest {
  method: "PUT" | "GET";
  url: string;
  headers: Record<string, string>;
  expiresAt: Date;
}

/**
 * Network operations accept an optional abort signal. Worker handlers pass the
 * signal of their outbox attempt so a timed-out, lease-lost or shutting-down
 * attempt stops its storage I/O instead of leaking it.
 */
export interface ObjectStore {
  createUploadRequest(input: {
    key: string;
    mediaType: string;
    sizeBytes: number;
    checksumSha256Base64: string;
    expiresInSeconds: number;
  }): Promise<PresignedRequest>;
  headObject(input: {
    key: string;
    versionId?: string;
    signal?: AbortSignal;
  }): Promise<StoredObjectMetadata | null>;
  getObject(input: {
    key: string;
    versionId: string;
    maxBytes: number;
    signal?: AbortSignal;
  }): Promise<Uint8Array>;
  copyObject(input: {
    sourceKey: string;
    sourceVersionId: string;
    destinationKey: string;
    mediaType: string;
    signal?: AbortSignal;
  }): Promise<{ versionId: string | null }>;
  deleteObject(input: {
    key: string;
    versionId?: string | null;
    signal?: AbortSignal;
  }): Promise<void>;
  createDownloadRequest(input: {
    key: string;
    versionId: string;
    mediaType: string;
    contentDisposition: string;
    expiresInSeconds: number;
  }): Promise<PresignedRequest>;
}
