import {
  ChecksumAlgorithm,
  ChecksumMode,
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type {
  ObjectStore,
  PresignedRequest,
  StoredObjectMetadata,
} from "./object-store";

export interface S3ObjectStoreOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  client?: S3Client;
}

export class S3ObjectStore implements ObjectStore {
  private readonly bucket: string;
  private readonly client: S3Client;

  constructor(options: S3ObjectStoreOptions) {
    if (!options.bucket.trim()) {
      throw new Error("ATTACHMENT_S3_BUCKET is required");
    }
    if (!options.region.trim()) {
      throw new Error("ATTACHMENT_S3_REGION is required");
    }
    this.bucket = options.bucket;
    this.client =
      options.client ??
      new S3Client({
        region: options.region,
        ...(options.endpoint ? { endpoint: options.endpoint } : {}),
        forcePathStyle: options.forcePathStyle ?? false,
        // Credentials intentionally come from the AWS SDK default chain.
      });
  }

  async createUploadRequest(input: {
    key: string;
    mediaType: string;
    sizeBytes: number;
    checksumSha256Base64: string;
    expiresInSeconds: number;
  }): Promise<PresignedRequest> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      ContentType: input.mediaType,
      ContentLength: input.sizeBytes,
      IfNoneMatch: "*",
      ChecksumAlgorithm: ChecksumAlgorithm.SHA256,
      ChecksumSHA256: input.checksumSha256Base64,
    });
    const url = await getSignedUrl(this.client, command, {
      expiresIn: input.expiresInSeconds,
      unhoistableHeaders: new Set([
        "x-amz-checksum-sha256",
        "if-none-match",
      ]),
    });
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
  }

  async headObject(input: {
    key: string;
    versionId?: string;
  }): Promise<StoredObjectMetadata | null> {
    try {
      const output = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: input.key,
          ...(input.versionId ? { VersionId: input.versionId } : {}),
          ChecksumMode: ChecksumMode.ENABLED,
        }),
      );
      return {
        versionId: output.VersionId ?? null,
        sizeBytes: output.ContentLength ?? -1,
        checksumSha256Base64: output.ChecksumSHA256 ?? null,
        contentType: output.ContentType ?? null,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async getObject(input: {
    key: string;
    versionId: string;
    maxBytes: number;
  }): Promise<Uint8Array> {
    const output = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        VersionId: input.versionId,
        ChecksumMode: ChecksumMode.ENABLED,
      }),
    );
    if (!output.Body) throw new Error("S3 object has no body");

    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const rawChunk of output.Body as AsyncIterable<Uint8Array>) {
      const chunk =
        rawChunk instanceof Uint8Array
          ? rawChunk
          : new Uint8Array(rawChunk as ArrayBuffer);
      total += chunk.byteLength;
      if (total > input.maxBytes) {
        throw new Error("Stored object exceeds the configured attachment limit");
      }
      chunks.push(chunk);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }

  async copyObject(input: {
    sourceKey: string;
    sourceVersionId: string;
    destinationKey: string;
    mediaType: string;
  }): Promise<{ versionId: string | null }> {
    const source = `${encodeS3Path(this.bucket)}/${encodeS3Path(
      input.sourceKey,
    )}?versionId=${encodeURIComponent(input.sourceVersionId)}`;
    const output = await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: input.destinationKey,
        CopySource: source,
        ContentType: input.mediaType,
        MetadataDirective: "REPLACE",
        TaggingDirective: "REPLACE",
        ChecksumAlgorithm: "SHA256",
      }),
    );
    return { versionId: output.VersionId ?? null };
  }

  async deleteObject(input: {
    key: string;
    versionId?: string | null;
  }): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        ...(input.versionId ? { VersionId: input.versionId } : {}),
      }),
    );
  }

  async createDownloadRequest(input: {
    key: string;
    versionId: string;
    mediaType: string;
    contentDisposition: string;
    expiresInSeconds: number;
  }): Promise<PresignedRequest> {
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        VersionId: input.versionId,
        ResponseContentType: input.mediaType,
        ResponseContentDisposition: input.contentDisposition,
      }),
      { expiresIn: input.expiresInSeconds },
    );
    return {
      method: "GET",
      url,
      headers: {},
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
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
    forcePathStyle: env.ATTACHMENT_S3_FORCE_PATH_STYLE === "true",
  });
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
