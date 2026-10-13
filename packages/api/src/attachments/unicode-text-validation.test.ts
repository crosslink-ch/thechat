import { describe, expect, test } from "bun:test";
import { verifyFileType } from "./file-validation";

const csv = '\uFEFF"#","keyword","position"\r\n"1","synthetic term","4"\r\n';

test("keeps UTF-16LE CSV as an opaque CSV instead of MPEG audio", async () => {
  const bytes = new Uint8Array(Buffer.from(csv, "utf16le"));
  const original = bytes.slice();
  expect(await verifyFileType(bytes, "text/csv")).toEqual({
    mediaType: "text/csv",
    storageMediaType: "application/octet-stream",
    kind: "file",
    width: null,
    height: null,
  });
  expect(bytes).toEqual(original);
});

describe("Unicode text classification boundaries", () => {
  test("recognizes UTF-16BE text while preserving its declaration", async () => {
    const bytes = Buffer.from(csv, "utf16le").swap16();
    expect((await verifyFileType(bytes, "Text/CSV; charset=utf-16be")).mediaType).toBe("text/csv");
  });

  test("keeps a Unicode CSV subarray independent of its backing buffer", async () => {
    const csvBytes = Buffer.from(csv, "utf16le");
    const backing = Buffer.concat([Buffer.from([0, 1, 2]), csvBytes, Buffer.from([3])]);
    expect((await verifyFileType(backing.subarray(3, -1), "text/csv")).mediaType).toBe("text/csv");
  });

  test("keeps UTF-8 CSV as an opaque CSV", async () => {
    expect(await verifyFileType(new TextEncoder().encode(csv.slice(1)), "text/csv")).toMatchObject({
      mediaType: "text/csv", storageMediaType: "application/octet-stream", kind: "file",
    });
  });

  test.each([
    ["odd-length code unit", [0xff, 0xfe, 0x22, 0x00, 0x23]],
    ["unpaired high surrogate", [0xff, 0xfe, 0x00, 0xd8]],
    ["unpaired low surrogate", [0xff, 0xfe, 0x00, 0xdc]],
    ["NUL content", [0xff, 0xfe, 0x00, 0x00]],
    ["binary control content", [0xff, 0xfe, 0x01, 0x00]],
  ])("does not treat %s as validated text", async (_name, values) => {
    const result = await verifyFileType(new Uint8Array(values as number[]), "text/csv");
    expect(result.mediaType).not.toBe("text/csv");
    expect(result.storageMediaType).toBe("application/octet-stream");
    expect(result.kind).toBe("file");
  });

  test.each(["audio/mpeg", "application/octet-stream", "", "invalid MIME"])(
    "does not bypass binary detection for the declaration %s", async (mediaType) => {
      expect((await verifyFileType(new Uint8Array(Buffer.from(csv, "utf16le")), mediaType)).mediaType).toBe("audio/mpeg");
    },
  );
});
