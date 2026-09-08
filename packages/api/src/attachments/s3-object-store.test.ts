import { afterEach, describe, expect, test } from "bun:test";
import { S3Client } from "@aws-sdk/client-s3";
import { S3ObjectStore, createS3ObjectStoreFromEnv } from "./s3-object-store";

const clients: S3Client[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
});

function signingClient() {
  const client = new S3Client({
    region: "eu-central-1",
    credentials: {
      accessKeyId: "test-access-key-id",
      secretAccessKey: "testtesttesttesttesttesttesttesttesttest",
    },
  });
  clients.push(client);
  return client;
}

describe("S3 attachment object store", () => {
  test("production overlay signs dualstack virtual-host PUT and GET without moving server I/O", async () => {
    const overlay = await Bun.file(new URL("../../../../deploy/api/values-web-production.yaml", import.meta.url)).text();
    const publicEndpoint = overlay.match(/ATTACHMENT_S3_PUBLIC_ENDPOINT:\s*"([^"]+)"/)?.[1];
    expect(publicEndpoint).toBe("https://s3.dualstack.eu-central-1.amazonaws.com");
    const client = signingClient();
    const store = new S3ObjectStore({
      bucket: "synthetic-production-bucket", region: "eu-central-1", client,
      publicEndpoint, forcePathStyle: false,
    });
    const upload = await store.createUploadRequest({
      key: "quarantine/id", mediaType: "text/plain", sizeBytes: 5,
      checksumSha256Base64: "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=", expiresInSeconds: 300,
    });
    const download = await store.createDownloadRequest({
      key: "clean/id", versionId: "v1", mediaType: "text/plain",
      contentDisposition: 'attachment; filename="example.txt"', expiresInSeconds: 90,
    });
    for (const request of [upload, download]) {
      const url = new URL(request.url);
      expect(url.origin).toBe("https://synthetic-production-bucket.s3.dualstack.eu-central-1.amazonaws.com");
      expect(url.searchParams.has("X-Amz-Signature")).toBe(true);
    }
    expect(new URL(download.url).searchParams.get("versionId")).toBe("v1");
    expect(upload.headers["if-none-match"]).toBe("*");
    let internalCalls = 0;
    client.send = (async () => { internalCalls++; return { ContentLength: 5, VersionId: "v1" }; }) as any;
    await store.headObject({ key: "quarantine/id" });
    expect(internalCalls).toBe(1);
  });

  test("loads and validates the optional browser endpoint from environment", () => {
    expect(() => { createS3ObjectStoreFromEnv({
      ATTACHMENT_S3_BUCKET: 'preview-bucket', ATTACHMENT_S3_REGION: 'eu-central-1',
      ATTACHMENT_S3_PUBLIC_ENDPOINT: 'http://unsafe.example.invalid',
    }); }).toThrow('ATTACHMENT_S3_PUBLIC_ENDPOINT');
  });
  test("signs browser uploads for a public endpoint without moving worker traffic", async () => {
    const client = signingClient();
    const store = new S3ObjectStore({
      bucket: "preview-bucket",
      region: "eu-central-1",
      client,
      endpoint: "http://127.0.0.1:19000",
      publicEndpoint: "https://objects.example.invalid:8445",
      forcePathStyle: true,
    });
    const upload = await store.createUploadRequest({
      key: "quarantine/id",
      mediaType: "text/plain",
      sizeBytes: 5,
      checksumSha256Base64: "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=",
      expiresInSeconds: 300,
    });
    expect(new URL(upload.url).origin).toBe("https://objects.example.invalid:8445");
    expect(new URL(upload.url).pathname).toBe("/preview-bucket/quarantine/id");
    let called = false;
    client.send = (async () => { called = true; return { ContentLength: 5, VersionId: "v1" }; }) as any;
    await store.headObject({ key: "quarantine/id" });
    expect(called).toBe(true);
  });

  test("signs downloads against the configured browser endpoint", async () => {
    const store = new S3ObjectStore({
      bucket: "preview-bucket",
      region: "eu-central-1",
      client: signingClient(),
      publicEndpoint: "https://objects.example.invalid:8445",
      forcePathStyle: true,
    });
    const download = await store.createDownloadRequest({
      key: "clean/id", versionId: "v1", mediaType: "text/plain",
      contentDisposition: 'attachment; filename="example.txt"', expiresInSeconds: 90,
    });
    expect(new URL(download.url).origin).toBe("https://objects.example.invalid:8445");
    expect(new URL(download.url).searchParams.get("versionId")).toBe("v1");
  });

  test.each([
    'http://objects.example.invalid', 'ftp://objects.example.invalid',
    'https://user:password@objects.example.invalid',
    'https://objects.example.invalid?secret=value', 'https://objects.example.invalid/#fragment',
    'https://objects.example.invalid/prefix',
  ])("rejects unsafe public endpoint configuration %s", (publicEndpoint) => {
    expect(() => { new S3ObjectStore({
      bucket: 'preview-bucket', region: 'eu-central-1', client: signingClient(), publicEndpoint,
    }); }).toThrow('ATTACHMENT_S3_PUBLIC_ENDPOINT');
  });

  test("binds upload size and checksum into a short-lived private PUT", async () => {
    const checksum = "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=";
    const store = new S3ObjectStore({
      bucket: "private-attachment-bucket",
      region: "eu-central-1",
      client: signingClient(),
    });

    const request = await store.createUploadRequest({
      key: "quarantine/opaque-id",
      mediaType: "text/plain",
      sizeBytes: 5,
      checksumSha256Base64: checksum,
      expiresInSeconds: 300,
    });
    const url = new URL(request.url);
    const signedHeaders =
      url.searchParams.get("X-Amz-SignedHeaders")?.split(";") ?? [];
    const checksumParam = Array.from(url.searchParams.entries()).find(
      ([name]) => name.toLowerCase() === "x-amz-checksum-sha256",
    );

    expect(request.method).toBe("PUT");
    expect(url.protocol).toBe("https:");
    expect(url.pathname).toEndWith("/quarantine/opaque-id");
    expect(signedHeaders).toContain("content-length");
    expect(signedHeaders).toContain("if-none-match");
    expect(signedHeaders).toContain("x-amz-checksum-sha256");
    expect(checksumParam).toBeUndefined();
    expect(request.headers).toEqual({
      "content-type": "text/plain",
      "if-none-match": "*",
      "x-amz-checksum-sha256": checksum,
    });
    expect(request.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(request.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 301_000);
  });

  test("pins downloads to the clean object version and disposition", async () => {
    const store = new S3ObjectStore({
      bucket: "private-attachment-bucket",
      region: "eu-central-1",
      client: signingClient(),
    });

    const request = await store.createDownloadRequest({
      key: "clean/opaque-id",
      versionId: "version-1",
      mediaType: "application/pdf",
      contentDisposition: "attachment; filename=\"report.pdf\"",
      expiresInSeconds: 90,
    });
    const url = new URL(request.url);

    expect(request.method).toBe("GET");
    expect(url.searchParams.get("versionId")).toBe("version-1");
    expect(url.searchParams.get("response-content-type")).toBe("application/pdf");
    expect(url.searchParams.get("response-content-disposition")).toContain(
      "report.pdf",
    );
  });

  test("escapes every copy-source path component and pins the source version", async () => {
    let commandInput: any = null;
    const fakeClient = {
      send: async (command: { input: Record<string, unknown> }) => {
        commandInput = command.input;
        return { VersionId: "clean-version" };
      },
    } as unknown as S3Client;
    const store = new S3ObjectStore({
      bucket: "private bucket",
      region: "eu-central-1",
      client: fakeClient,
    });

    const copied = await store.copyObject({
      sourceKey: "quarantine/folder name/object+name",
      sourceVersionId: "v/1?x",
      destinationKey: "clean/id",
      mediaType: "text/plain",
    });

    expect(copied).toEqual({ versionId: "clean-version" });
    expect(commandInput?.CopySource).toBe(
      "private%20bucket/quarantine/folder%20name/object%2Bname?versionId=v%2F1%3Fx",
    );
    expect(commandInput?.MetadataDirective).toBe("REPLACE");
    expect(commandInput?.TaggingDirective).toBe("REPLACE");
    expect(commandInput?.ChecksumAlgorithm).toBe("SHA256");
  });

  test("deletes the exact private-object version instead of adding a key-only marker", async () => {
    let commandInput: any = null;
    const fakeClient = {
      send: async (command: { input: Record<string, unknown> }) => {
        commandInput = command.input;
        return {};
      },
    } as unknown as S3Client;
    const store = new S3ObjectStore({
      bucket: "private-attachment-bucket",
      region: "eu-central-1",
      client: fakeClient,
    });

    await store.deleteObject({
      key: "quarantine/opaque-id",
      versionId: "quarantine-version-1",
    });

    expect(commandInput).toEqual({
      Bucket: "private-attachment-bucket",
      Key: "quarantine/opaque-id",
      VersionId: "quarantine-version-1",
    });
  });
});
