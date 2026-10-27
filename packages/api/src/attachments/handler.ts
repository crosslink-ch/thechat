import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { attachments } from "../db/schema";
import type { DomainEventHandler } from "../events/registry";
import { withSpan } from "../observability";
import { loadAttachmentConfig } from "./config";
import {
  ATTACHMENT_DELETION_REQUESTED,
  ATTACHMENT_EVENT_VERSION,
  ATTACHMENT_VALIDATION_REQUESTED,
  parseAttachmentLifecycleEvent,
  type AttachmentLifecycleEvent,
} from "./events";
import { verifyFileType } from "./file-validation";
import type { ObjectStore } from "./object-store";
import { getAttachmentObjectStore } from "./service";

type ValidationEvent = AttachmentLifecycleEvent & {
  type: typeof ATTACHMENT_VALIDATION_REQUESTED;
};
type DeletionEvent = AttachmentLifecycleEvent & {
  type: typeof ATTACHMENT_DELETION_REQUESTED;
};

// Both handlers run in the worker's "attachments" lane. Its capacity
// (ATTACHMENT_VALIDATION_CONCURRENCY) bounds concurrent storage work per
// worker, so slow S3 I/O never occupies chat or bot-trigger capacity.

export function createAttachmentValidationHandler(options: {
  store?: ObjectStore;
} = {}): DomainEventHandler<ValidationEvent> {
  return {
    type: ATTACHMENT_VALIDATION_REQUESTED,
    version: ATTACHMENT_EVENT_VERSION,
    lane: "attachments",
    parse(value) {
      const event = parseAttachmentLifecycleEvent(value);
      if (event.type !== ATTACHMENT_VALIDATION_REQUESTED) {
        throw new Error("Not an attachment validation event");
      }
      return event as ValidationEvent;
    },
    async handle(event, context) {
      const config = loadAttachmentConfig();
      await validateAndPromoteAttachment(event.payload.attachmentId, {
        store: options.store ?? getAttachmentObjectStore(),
        maxBytes: config.maxBytes,
        signal: context?.signal,
      });
    },
  };
}

export function createAttachmentDeletionHandler(options: {
  store?: ObjectStore;
} = {}): DomainEventHandler<DeletionEvent> {
  return {
    type: ATTACHMENT_DELETION_REQUESTED,
    version: ATTACHMENT_EVENT_VERSION,
    lane: "attachments",
    parse(value) {
      const event = parseAttachmentLifecycleEvent(value);
      if (event.type !== ATTACHMENT_DELETION_REQUESTED) {
        throw new Error("Not an attachment deletion event");
      }
      return event as DeletionEvent;
    },
    async handle(event, context) {
      await deleteAttachmentObjects(
        event.payload.attachmentId,
        options.store ?? getAttachmentObjectStore(),
        context?.signal,
      );
    },
  };
}

export async function validateAndPromoteAttachment(
  attachmentId: string,
  input: {
    store: ObjectStore;
    maxBytes: number;
    signal?: AbortSignal;
  },
) {
  const signal = input.signal;
  return withSpan(
    "attachment.validate_promote",
    {
      "messaging.system": "thechat",
    },
    async (span) => {
      const row = await loadAttachment(attachmentId);
      if (!row) {
        span.setAttribute("thechat.attachment.outcome", "missing");
        return;
      }
      span.setAttribute("thechat.attachment.previous_status", row.status);
      if (row.status === "ready") {
        span.setAttribute("thechat.attachment.outcome", "already_ready");
        return;
      }
      if (row.status !== "processing") {
        span.setAttribute("thechat.attachment.outcome", "ignored_state");
        return;
      }
      if (
        !row.quarantineVersionId ||
        !row.cleanKey
      ) {
        throw new Error("Processing attachment is missing pinned object coordinates");
      }

      const expectedChecksumBase64 = Buffer.from(
        row.declaredChecksumSha256,
        "hex",
      ).toString("base64");
      signal?.throwIfAborted();
      const pinned = await input.store.headObject({
        key: row.quarantineKey,
        versionId: row.quarantineVersionId,
        signal,
      });
      if (
        !pinned ||
        pinned.versionId !== row.quarantineVersionId ||
        pinned.sizeBytes !== row.declaredSizeBytes ||
        pinned.checksumSha256Base64 !== expectedChecksumBase64
      ) {
        span.setAttribute("thechat.attachment.outcome", "rejected");
        span.setAttribute(
          "thechat.attachment.failure_reason",
          "stored_object_mismatch",
        );
        span.setAttribute("thechat.attachment.next_status", "rejected");
        await rejectAttachment(row, input.store, "stored_object_mismatch", signal);
        return;
      }

      signal?.throwIfAborted();
      const bytes = await input.store.getObject({
        key: row.quarantineKey,
        versionId: row.quarantineVersionId,
        maxBytes: Math.min(input.maxBytes, row.declaredSizeBytes),
        signal,
      });
      const checksum = crypto
        .createHash("sha256")
        .update(bytes)
        .digest("hex");
      if (
        bytes.byteLength !== row.declaredSizeBytes ||
        checksum !== row.declaredChecksumSha256
      ) {
        span.setAttribute("thechat.attachment.outcome", "rejected");
        span.setAttribute(
          "thechat.attachment.failure_reason",
          "content_mismatch",
        );
        span.setAttribute("thechat.attachment.next_status", "rejected");
        await rejectAttachment(row, input.store, "content_mismatch", signal);
        return;
      }

      const verified = await verifyFileType(bytes, row.declaredMediaType);

      // Do not probe a not-yet-created clean key: S3 intentionally returns
      // AccessDenied rather than NotFound to identities without ListBucket.
      // A retry can safely create another version at this deterministic key;
      // the bucket lifecycle removes superseded versions.
      signal?.throwIfAborted();
      const copied = await input.store.copyObject({
        sourceKey: row.quarantineKey,
        sourceVersionId: row.quarantineVersionId,
        destinationKey: row.cleanKey,
        mediaType: verified.storageMediaType,
        signal,
      });
      if (!copied.versionId) {
        throw new Error(
          "Attachment bucket versioning is required for clean objects",
        );
      }
      const clean = await input.store.headObject({
        key: row.cleanKey,
        versionId: copied.versionId,
        signal,
      });
      if (
        !clean?.versionId ||
        clean.sizeBytes !== row.declaredSizeBytes ||
        clean.checksumSha256Base64 !== expectedChecksumBase64
      ) {
        throw new Error("Promoted clean object failed integrity verification");
      }

      // An aborted attempt (timeout, lost lease, shutdown) must not promote:
      // the retry or the new lease owner repeats the idempotent steps above.
      signal?.throwIfAborted();
      const now = new Date();
      const [promoted] = await db
        .update(attachments)
        .set({
          status: "ready",
          cleanVersionId: clean.versionId,
          verifiedMediaType: verified.mediaType,
          verifiedSizeBytes: bytes.byteLength,
          verifiedChecksumSha256: checksum,
          width: verified.width,
          height: verified.height,
          readyAt: now,
          failureReason: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(attachments.id, row.id),
            eq(attachments.status, "processing"),
          ),
        )
        .returning({ id: attachments.id });
      if (!promoted) {
        span.setAttribute("thechat.attachment.outcome", "promotion_race_lost");
        await input.store.deleteObject({
          key: row.cleanKey,
          versionId: clean.versionId,
        });
        return;
      }
      span.setAttribute("thechat.attachment.kind", verified.kind);
      span.setAttribute("thechat.attachment.size_bytes", bytes.byteLength);
      span.setAttribute("thechat.attachment.outcome", "ready");
      span.setAttribute("thechat.attachment.next_status", "ready");
      // Keep the pinned quarantine version until the bucket lifecycle removes it.
      // The signed PUT uses If-None-Match: *, so retaining the object makes the
      // upload URL one-shot for its entire validity window.
    },
    { errorAttributes: { "thechat.attachment.outcome": "failed" } },
  );
}

export async function deleteAttachmentObjects(
  attachmentId: string,
  store: ObjectStore,
  signal?: AbortSignal,
) {
  return withSpan(
    "attachment.delete_objects",
    {
      "messaging.system": "thechat",
    },
    async (span) => {
      try {
        const row = await loadAttachment(attachmentId);
        if (!row) {
          span.setAttribute("thechat.attachment.outcome", "missing");
          return;
        }
        span.setAttribute("thechat.attachment.previous_status", row.status);
        if (row.status === "deleted") {
          span.setAttribute("thechat.attachment.outcome", "already_deleted");
          return;
        }
        if (row.status !== "deleting" && row.status !== "rejected") {
          span.setAttribute("thechat.attachment.outcome", "ignored_state");
          return;
        }

        await deletePinnedAttachmentObjects(row, store, signal);

        const nextStatus = row.status === "rejected" ? "rejected" : "deleted";
        const now = new Date();
        await db
          .update(attachments)
          .set({
            ...(row.status === "rejected" ? {} : { status: "deleted" }),
            quarantineVersionId: null,
            cleanVersionId: null,
            deletedAt: now,
            updatedAt: now,
          })
          .where(
            and(eq(attachments.id, row.id), eq(attachments.status, row.status)),
          );
        span.setAttribute("thechat.attachment.next_status", nextStatus);
        span.setAttribute(
          "thechat.attachment.outcome",
          row.status === "rejected" ? "rejection_cleaned" : "deleted",
        );
      } catch (error) {
        span.setAttribute("thechat.attachment.outcome", "failed");
        throw error;
      }
    },
  );
}

async function rejectAttachment(
  row: typeof attachments.$inferSelect,
  store: ObjectStore,
  reason: string,
  signal?: AbortSignal,
) {
  await deletePinnedAttachmentObjects(row, store, signal);
  const now = new Date();
  await db
    .update(attachments)
    .set({
      status: "rejected",
      quarantineVersionId: null,
      cleanVersionId: null,
      failureReason: reason,
      rejectedAt: now,
      deletedAt: now,
      updatedAt: now,
    })
    .where(
      and(eq(attachments.id, row.id), eq(attachments.status, "processing")),
    );
}

async function deletePinnedAttachmentObjects(
  row: typeof attachments.$inferSelect,
  store: ObjectStore,
  signal?: AbortSignal,
) {
  if (row.cleanKey && row.cleanVersionId) {
    await store.deleteObject({
      key: row.cleanKey,
      versionId: row.cleanVersionId,
      signal,
    });
  }
  await store.deleteObject({
    key: row.quarantineKey,
    versionId: row.quarantineVersionId,
    signal,
  });
}

async function loadAttachment(id: string) {
  const [row] = await db
    .select()
    .from(attachments)
    .where(eq(attachments.id, id))
    .limit(1);
  return row ?? null;
}
