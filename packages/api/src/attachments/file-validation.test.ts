import { describe, expect, test } from "bun:test";
import {
  UnsafeAttachmentError,
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

async function rejectionReason(bytes: Uint8Array, mediaType: string) {
  try {
    await verifyFileType(bytes, mediaType);
  } catch (error) {
    expect(error).toBeInstanceOf(UnsafeAttachmentError);
    return (error as UnsafeAttachmentError).reason;
  }
  throw new Error("Expected attachment verification to reject");
}

describe("attachment file validation", () => {
  test("normalizes aliases and media-type parameters", () => {
    expect(normalizeDeclaredMediaType(" Image/JPG ; charset=binary ")).toBe(
      "image/jpeg",
    );
  });

  test("accepts a raster signature and records dimensions", async () => {
    const result = await verifyFileType(png(640, 480), "image/png");
    expect(result).toEqual({
      mediaType: "image/png",
      kind: "image",
      width: 640,
      height: 480,
    });
  });

  test("rejects raster dimensions that can exhaust renderer memory", async () => {
    expect(
      await rejectionReason(png(16_384, 16_384), "image/png"),
    ).toBe("image_dimensions_exceeded");
  });

  test("accepts valid UTF-8 text and JSON", async () => {
    expect(await verifyFileType(encoder.encode("plain text"), "text/plain"))
      .toMatchObject({ mediaType: "text/plain", kind: "file" });
    expect(
      await verifyFileType(encoder.encode('{"safe":true}'), "application/json"),
    ).toMatchObject({ mediaType: "application/json", kind: "file" });
  });

  test("rejects active content even when declared as plain text", async () => {
    expect(
      await rejectionReason(
        encoder.encode("<!doctype html><script>alert(1)</script>"),
        "text/plain",
      ),
    ).toBe("active_content");
  });

  test("rejects executables, archives, invalid JSON, and MIME confusion", async () => {
    expect(
      await rejectionReason(
        new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02]),
        "application/pdf",
      ),
    ).toBe("executable_or_archive");
    expect(
      await rejectionReason(
        new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]),
        "application/pdf",
      ),
    ).toBe("executable_or_archive");
    expect(
      await rejectionReason(encoder.encode("{not json}"), "application/json"),
    ).toBe("invalid_json");
    expect(
      await rejectionReason(encoder.encode("%PDF-1.7\n"), "image/png"),
    ).toBe("media_type_mismatch");
  });
});
