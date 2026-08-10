import { fileTypeFromBuffer } from "file-type";

export const OPAQUE_ATTACHMENT_MEDIA_TYPE = "application/octet-stream";

const RASTER_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const MAX_RASTER_DIMENSION = 16_384;
const MAX_RASTER_PIXELS = 40_000_000;
const MEDIA_TYPE_PATTERN =
  /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/;

const MEDIA_TYPE_ALIASES: Record<string, string> = {
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "image/jpg": "image/jpeg",
  "text/x-markdown": "text/markdown",
};

export interface VerifiedFile {
  mediaType: string;
  storageMediaType: string;
  kind: "image" | "file";
  width: number | null;
  height: number | null;
}

export function normalizeDeclaredMediaType(value: string) {
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const aliased = MEDIA_TYPE_ALIASES[normalized] ?? normalized;
  return MEDIA_TYPE_PATTERN.test(aliased)
    ? aliased
    : OPAQUE_ATTACHMENT_MEDIA_TYPE;
}

export async function verifyFileType(
  bytes: Uint8Array,
  declaredMediaType: string,
): Promise<VerifiedFile> {
  const declared = normalizeDeclaredMediaType(declaredMediaType);
  let detectedMediaType: string | null = null;
  try {
    const detected = await fileTypeFromBuffer(bytes);
    detectedMediaType = detected
      ? normalizeDeclaredMediaType(detected.mime)
      : null;
  } catch {
    // A detector failure must not turn an otherwise valid opaque upload into a
    // rejection. Only positively identified safe raster formats are previewed.
  }

  const mediaType = detectedMediaType ?? declared;
  if (detectedMediaType && RASTER_MEDIA_TYPES.has(detectedMediaType)) {
    const dimensions = readRasterDimensions(bytes, detectedMediaType);
    if (
      dimensions &&
      dimensions.width > 0 &&
      dimensions.height > 0 &&
      dimensions.width <= MAX_RASTER_DIMENSION &&
      dimensions.height <= MAX_RASTER_DIMENSION &&
      dimensions.width * dimensions.height <= MAX_RASTER_PIXELS
    ) {
      return {
        mediaType,
        storageMediaType: mediaType,
        kind: "image",
        width: dimensions.width,
        height: dimensions.height,
      };
    }
  }

  return {
    mediaType,
    storageMediaType: OPAQUE_ATTACHMENT_MEDIA_TYPE,
    kind: "file",
    width: null,
    height: null,
  };
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
