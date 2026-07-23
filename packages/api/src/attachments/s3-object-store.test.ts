import { afterEach, describe, expect, test } from "bun:test";
import { S3Client } from "@aws-sdk/client-s3";
import { S3ObjectStore } from "./s3-object-store";

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
});
