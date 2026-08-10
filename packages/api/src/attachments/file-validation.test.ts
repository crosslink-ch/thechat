import { describe, expect, test } from "bun:test";
import {
  normalizeDeclaredMediaType,
  verifyFileType,
} from "./file-validation";

const encoder = new TextEncoder();

function png(width: number, height: number) {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

describe("attachment file validation", () => {
  test("normalizes aliases and falls back for absent or malformed declarations", () => {
    expect(normalizeDeclaredMediaType(" Image/JPG ; charset=binary ")).toBe(
      "image/jpeg",
    );
    expect(normalizeDeclaredMediaType("text/x-markdown")).toBe("text/markdown");
    expect(normalizeDeclaredMediaType("")).toBe("application/octet-stream");
    expect(normalizeDeclaredMediaType("not a media type\n")).toBe(
      "application/octet-stream",
    );
  });

  test("accepts a detected raster and records its safe preview dimensions", async () => {
    const result = await verifyFileType(png(640, 480), "application/octet-stream");
    expect(result).toEqual({
      mediaType: "image/png",
      storageMediaType: "image/png",
      kind: "image",
      width: 640,
      height: 480,
    });
  });

  test("keeps oversized or spoofed rasters as opaque downloadable files", async () => {
    expect(await verifyFileType(png(16_384, 16_384), "image/png")).toEqual({
      mediaType: "image/png",
      storageMediaType: "application/octet-stream",
      kind: "file",
      width: null,
      height: null,
    });
    expect(
      await verifyFileType(encoder.encode("not an image"), "image/png"),
    ).toEqual({
      mediaType: "image/png",
      storageMediaType: "application/octet-stream",
      kind: "file",
      width: null,
      height: null,
    });
  });

  test("accepts common missing formats and unknown MIME types as files", async () => {
    for (const mediaType of [
      "text/markdown",
      "message/rfc822",
      "application/vnd.ms-outlook",
      "application/x-future-format",
    ]) {
      expect(await verifyFileType(encoder.encode("opaque contents"), mediaType))
        .toEqual({
          mediaType,
          storageMediaType: "application/octet-stream",
          kind: "file",
          width: null,
          height: null,
        });
    }
  });

  test("accepts active content, archives, and executables without previewing them", async () => {
    const cases: Array<[Uint8Array, string]> = [
      [encoder.encode("<html><script>alert(1)</script></html>"), "text/html"],
      [encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), "image/svg+xml"],
      [new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]), "application/zip"],
      [new Uint8Array([0x4d, 0x5a, 0, 0]), "application/x-msdownload"],
    ];

    for (const [bytes, mediaType] of cases) {
      expect(await verifyFileType(bytes, mediaType)).toMatchObject({
        storageMediaType: "application/octet-stream",
        kind: "file",
        width: null,
        height: null,
      });
    }
  });
});
