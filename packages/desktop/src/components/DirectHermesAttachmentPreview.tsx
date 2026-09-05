import { useEffect, useState } from "react";
import { DIRECT_HERMES_ATTACHMENT_MAX_BYTES, type DirectHermesAttachment } from "../lib/direct-hermes-chat";

/** Only renderer-owned bytes can become previews. Never fetch gateway paths. */
export function DirectHermesAttachmentPreview({ attachment }: { attachment: DirectHermesAttachment }) {
  const file = attachment.type === "image" ? attachment.file : undefined;
  const [preview, setPreview] = useState<{ file: File; url: string }>();
  useEffect(() => {
    setPreview(undefined);
    if (!file || !file.size || file.size > DIRECT_HERMES_ATTACHMENT_MAX_BYTES || file.type !== "image/png" || typeof URL.createObjectURL !== "function") return;
    const reader = new FileReader();
    let cancelled = false;
    let url: string | undefined;
    reader.onload = () => {
      if (cancelled || !reader.result || typeof reader.result === "string" || !safePngDimensions(new Uint8Array(reader.result))) return;
      url = URL.createObjectURL(file);
      setPreview({ file, url });
    };
    reader.readAsArrayBuffer(file);
    return () => { cancelled = true; if (reader.readyState === FileReader.LOADING) reader.abort(); if (url) URL.revokeObjectURL(url); };
  }, [file]);
  if (attachment.type !== "image") return null;
  if (!preview || preview.file !== file) return <p className="text-xs text-text-dimmed">Image preview unavailable</p>;
  return <img src={preview.url} alt={`Local preview of ${attachment.name}`} className="mb-1 max-h-24 max-w-full rounded object-contain" onError={() => setPreview(undefined)} />;
}

// Inspect encoded dimensions before allocating a decoded image. Animation and
// unsupported formats remain attachable; their metadata is the safe fallback.
function safePngDimensions(bytes: Uint8Array) {
  if (bytes.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return false;
  const width = view.getUint32(16), height = view.getUint32(20);
  if (!width || !height || width > 4096 || height > 4096 || width * height > 4_000_000) return false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset), type = view.getUint32(offset + 4);
    if (length > bytes.length - offset - 12 || type === 0x6163544c) return false; // acTL
    if (type === 0x49454e44) return true; // IEND
    offset += length + 12;
  }
  return false;
}
