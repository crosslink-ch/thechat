import { asc, eq, inArray } from "drizzle-orm";
import type { AttachmentView } from "@thechat/shared";
import { db } from "../db";
import { attachments, messageAttachments } from "../db/schema";
import { OPAQUE_ATTACHMENT_MEDIA_TYPE } from "./file-validation";

export type AttachmentRow = typeof attachments.$inferSelect;

export function toAttachmentView(
  row: AttachmentRow,
  options: { includeStatus?: boolean } = {},
): AttachmentView {
  const mediaType = row.verifiedMediaType ?? row.declaredMediaType;
  const sizeBytes = row.verifiedSizeBytes ?? row.declaredSizeBytes;
  return {
    id: row.id,
    fileName: row.fileName,
    name: row.fileName,
    mediaType,
    mimeType: mediaType,
    sizeBytes,
    kind: isInlinePreview(mediaType, row.width, row.height) ? "image" : "file",
    width: row.width,
    height: row.height,
    ...(options.includeStatus ? { status: row.status } : {}),
    contentPath: `/attachments/${row.id}/content`,
  };
}

export async function attachmentsByMessageIds(
  messageIds: string[],
): Promise<Map<string, AttachmentView[]>> {
  const result = new Map<string, AttachmentView[]>();
  for (const id of messageIds) result.set(id, []);
  if (messageIds.length === 0) return result;

  const rows = await db
    .select({
      messageId: messageAttachments.messageId,
      attachment: attachments,
    })
    .from(messageAttachments)
    .innerJoin(
      attachments,
      eq(messageAttachments.attachmentId, attachments.id),
    )
    .where(inArray(messageAttachments.messageId, messageIds))
    .orderBy(
      asc(messageAttachments.messageId),
      asc(messageAttachments.position),
    );

  for (const row of rows) {
    result.get(row.messageId)?.push(toAttachmentView(row.attachment));
  }
  return result;
}

export function isInlineRaster(mediaType: string) {
  return (
    mediaType === "image/png" ||
    mediaType === "image/jpeg" ||
    mediaType === "image/gif" ||
    mediaType === "image/webp"
  );
}

export function isInlinePreview(
  mediaType: string,
  width: number | null,
  height: number | null,
) {
  return (
    isInlineRaster(mediaType) &&
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width !== null &&
    height !== null &&
    width > 0 &&
    height > 0
  );
}

export function safeDownloadMediaType(
  mediaType: string,
  width: number | null,
  height: number | null,
) {
  return isInlinePreview(mediaType, width, height)
    ? mediaType
    : OPAQUE_ATTACHMENT_MEDIA_TYPE;
}
