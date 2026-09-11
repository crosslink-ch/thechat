import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileTypeFromBuffer } from "file-type";
import { verifyFileType } from "./file-validation";
import { safeDownloadMediaType, toAttachmentView, type AttachmentRow } from "./public";

test("browser-recorded WebM retains audio MIME in the public DTO but stays opaque", async () => {
  const bytes = await readFile(new URL("./fixtures/chromium-voice.webm", import.meta.url));
  expect(await fileTypeFromBuffer(bytes)).toMatchObject({ mime: "video/webm" });
  const verified = await verifyFileType(bytes, "audio/webm;codecs=opus");
  expect(verified).toEqual({ mediaType: "audio/webm", storageMediaType: "application/octet-stream", kind: "file", width: null, height: null });
  const dto = toAttachmentView({
    id: "voice", fileName: "voice.webm", verifiedMediaType: verified.mediaType,
    declaredMediaType: "audio/webm", verifiedSizeBytes: bytes.length,
    declaredSizeBytes: bytes.length, width: null, height: null, status: "attached",
  } as AttachmentRow);
  expect(dto).toEqual({ id: "voice", fileName: "voice.webm", name: "voice.webm", mediaType: "audio/webm", mimeType: "audio/webm", sizeBytes: bytes.length, kind: "file", width: null, height: null, contentPath: "/attachments/voice/content" });
  expect(safeDownloadMediaType(dto.mediaType, null, null)).toBe("application/octet-stream");
});
