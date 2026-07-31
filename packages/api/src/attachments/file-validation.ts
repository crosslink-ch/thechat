import { fileTypeFromBuffer } from "file-type";

const RASTER_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const MAX_RASTER_DIMENSION = 16_384;
const MAX_RASTER_PIXELS = 40_000_000;

const ALLOWED_MEDIA_TYPES = new Set([
  ...RASTER_MEDIA_TYPES,
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/json",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "video/mp4",
  "video/webm",
]);

const MEDIA_TYPE_ALIASES: Record<string, string> = {
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "image/jpg": "image/jpeg",
};

export interface VerifiedFile {
  mediaType: string;
  kind: "image" | "file";
  width: number | null;
  height: number | null;
}

export function normalizeDeclaredMediaType(value: string) {
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return MEDIA_TYPE_ALIASES[normalized] ?? normalized;
}

export function isAllowedDeclaredMediaType(value: string) {
  return ALLOWED_MEDIA_TYPES.has(normalizeDeclaredMediaType(value));
}

export async function verifyFileType(
  bytes: Uint8Array,
  declaredMediaType: string,
): Promise<VerifiedFile> {
  const declared = normalizeDeclaredMediaType(declaredMediaType);
  if (!ALLOWED_MEDIA_TYPES.has(declared)) {
    throw new UnsafeAttachmentError("unsupported_media_type");
  }
  if (hasExecutableOrArchiveSignature(bytes)) {
    throw new UnsafeAttachmentError("executable_or_archive");
  }
  if (looksLikeActiveText(bytes)) {
    throw new UnsafeAttachmentError("active_content");
  }

  const detected = await fileTypeFromBuffer(bytes);
  const detectedMediaType = detected
    ? normalizeDeclaredMediaType(detected.mime)
    : null;
  if (detectedMediaType && detectedMediaType !== declared) {
    throw new UnsafeAttachmentError("media_type_mismatch");
  }
  if (!detectedMediaType && !isTextMediaType(declared)) {
    throw new UnsafeAttachmentError("unrecognized_binary");
  }
  if (isTextMediaType(declared) && !looksLikePlainText(bytes)) {
    throw new UnsafeAttachmentError("invalid_text");
  }
  if (declared === "application/json") {
    try {
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new UnsafeAttachmentError("invalid_json");
    }
  }

  const dimensions = RASTER_MEDIA_TYPES.has(declared)
    ? readRasterDimensions(bytes, declared)
    : null;
  if (RASTER_MEDIA_TYPES.has(declared)) {
    if (!dimensions || dimensions.width < 1 || dimensions.height < 1) {
      throw new UnsafeAttachmentError("invalid_image_dimensions");
    }
    if (
      dimensions.width > MAX_RASTER_DIMENSION ||
      dimensions.height > MAX_RASTER_DIMENSION ||
      dimensions.width * dimensions.height > MAX_RASTER_PIXELS
    ) {
      throw new UnsafeAttachmentError("image_dimensions_exceeded");
    }
  }
  return {
    mediaType: detectedMediaType ?? declared,
    kind: RASTER_MEDIA_TYPES.has(declared) ? "image" : "file",
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
  };
}

export class UnsafeAttachmentError extends Error {
  constructor(public readonly reason: string) {
    super(`Attachment rejected: ${reason}`);
  }
}

function isTextMediaType(mediaType: string) {
  return (
    mediaType === "text/plain" ||
    mediaType === "text/csv" ||
    mediaType === "application/json"
  );
}

function looksLikePlainText(bytes: Uint8Array) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return !text.includes("\0");
  } catch {
    return false;
  }
}

function looksLikeActiveText(bytes: Uint8Array) {
  const prefix = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, Math.min(bytes.byteLength, 8192)))
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();
  return (
    prefix.startsWith("<!doctype html") ||
    prefix.startsWith("<html") ||
    prefix.startsWith("<script") ||
    prefix.startsWith("<svg") ||
    (prefix.startsWith("<?xml") && prefix.includes("<svg"))
  );
}

function hasExecutableOrArchiveSignature(bytes: Uint8Array) {
  if (bytes.byteLength < 4) return false;
  const b = bytes;
  return (
    (b[0] === 0x4d && b[1] === 0x5a) || // PE
    (b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) || // ELF
    (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) || // ZIP
    (b[0] === 0x52 && b[1] === 0x61 && b[2] === 0x72 && b[3] === 0x21) || // RAR
    (b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf) || // 7z
    (b[0] === 0xca && b[1] === 0xfe && b[2] === 0xba && b[3] === 0xbe) || // Mach/Java
    (b[0] === 0xcf && b[1] === 0xfa && b[2] === 0xed && b[3] === 0xfe) ||
    (b[0] === 0xfe && b[1] === 0xed && b[2] === 0xfa && b[3] === 0xcf) ||
    (b[0] === 0x23 && b[1] === 0x21) // executable script
  );
}

function readRasterDimensions(
  bytes: Uint8Array,
  mediaType: string,
): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mediaType === "image/png" && bytes.byteLength >= 24) {
    return {
      width: view.getUint32(16, false),
      height: view.getUint32(20, false),
    };
  }
  if (mediaType === "image/gif" && bytes.byteLength >= 10) {
    return {
      width: view.getUint16(6, true),
      height: view.getUint16(8, true),
    };
  }
  if (mediaType === "image/jpeg") {
    let offset = 2;
    while (offset + 9 < bytes.byteLength) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      const length = view.getUint16(offset + 2, false);
      if (
        marker >= 0xc0 &&
        marker <= 0xc3 &&
        marker !== 0xc4
      ) {
        return {
          height: view.getUint16(offset + 5, false),
          width: view.getUint16(offset + 7, false),
        };
      }
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  if (mediaType === "image/webp" && bytes.byteLength >= 30) {
    const chunk = String.fromCharCode(
      bytes[12] ?? 0,
      bytes[13] ?? 0,
      bytes[14] ?? 0,
      bytes[15] ?? 0,
    );
    if (chunk === "VP8X") {
      return {
        width: 1 + readUint24Le(bytes, 24),
        height: 1 + readUint24Le(bytes, 27),
      };
    }
    if (
      chunk === "VP8 " &&
      bytes[23] === 0x9d &&
      bytes[24] === 0x01 &&
      bytes[25] === 0x2a
    ) {
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    }
    if (chunk === "VP8L" && bytes[20] === 0x2f) {
      return {
        width: 1 + ((bytes[21] ?? 0) | (((bytes[22] ?? 0) & 0x3f) << 8)),
        height:
          1 +
          (((bytes[22] ?? 0) >> 6) |
            ((bytes[23] ?? 0) << 2) |
            (((bytes[24] ?? 0) & 0x0f) << 10)),
      };
    }
  }
  return null;
}

function readUint24Le(bytes: Uint8Array, offset: number) {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16)
  );
}
