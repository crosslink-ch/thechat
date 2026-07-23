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
  }): Promise<StoredObjectMetadata | null>;
  getObject(input: {
    key: string;
    versionId: string;
    maxBytes: number;
  }): Promise<Uint8Array>;
  copyObject(input: {
    sourceKey: string;
    sourceVersionId: string;
    destinationKey: string;
    mediaType: string;
  }): Promise<{ versionId: string | null }>;
  deleteObject(input: {
    key: string;
    versionId?: string | null;
  }): Promise<void>;
  createDownloadRequest(input: {
    key: string;
    versionId: string;
    mediaType: string;
    contentDisposition: string;
    expiresInSeconds: number;
  }): Promise<PresignedRequest>;
}
