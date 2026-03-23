import { invoke } from "@tauri-apps/api/core";

export interface ImageAttachment {
  id: string;
  mimeType: string;
  base64: string;
}

export interface ImageRef {
  path: string;
  mimeType: string;
}

/** Save an image to disk and return the file path. */
export async function saveImage(
  conversationId: string,
  image: ImageAttachment,
): Promise<string> {
  return invoke<string>("save_image", {
    conversationId,
    imageId: image.id,
    mimeType: image.mimeType,
    base64Data: image.base64,
  });
}

/** Load an image from disk as base64. */
export async function loadImageBase64(filePath: string): Promise<string> {
  return invoke<string>("load_image_base64", { filePath });
}

/** Convert an ImageRef to an OpenAI-format content part (with inline base64). */
export async function imageRefToContentPart(
  ref_: ImageRef,
): Promise<{ type: "image_url"; image_url: { url: string } }> {
  const base64 = await loadImageBase64(ref_.path);
  return {
    type: "image_url",
    image_url: { url: `data:${ref_.mimeType};base64,${base64}` },
  };
}

/**
 * Build an OpenAI-format content array from text and image refs.
 * Returns a string if there are no images (for backward compat),
 * or a content array if there are images.
 */
export async function buildUserContent(
  text: string,
  images?: ImageRef[],
): Promise<string | Array<Record<string, unknown>>> {
  if (!images || images.length === 0) return text;

  const parts: Array<Record<string, unknown>> = [];
  if (text) {
    parts.push({ type: "text", text });
  }
  for (const img of images) {
    parts.push(await imageRefToContentPart(img));
  }
  return parts;
}
