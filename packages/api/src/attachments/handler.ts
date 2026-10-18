import crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { attachments } from "../db/schema";
import type { DomainEventHandler } from "../events/registry";
import { withSpan } from "../observability";
import { drainAttachmentObjectCleanup, persistObjectCleanup } from "./durable-cleanup";
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
import { withWorkspaceWorkBudget, type WorkspaceWorkLease } from "../services/workspace-resource-budgets";
import { getAttachmentObjectStore } from "./service";

type ValidationEvent = AttachmentLifecycleEvent & {
  type: typeof ATTACHMENT_VALIDATION_REQUESTED;
};
type DeletionEvent = AttachmentLifecycleEvent & {
  type: typeof ATTACHMENT_DELETION_REQUESTED;
};


export function createAttachmentValidationHandler(options: {
  store?: ObjectStore;
} = {}): DomainEventHandler<ValidationEvent> {
  return {
    type: ATTACHMENT_VALIDATION_REQUESTED,
    version: ATTACHMENT_EVENT_VERSION,
    parse(value) {
      const event = parseAttachmentLifecycleEvent(value);
      if (event.type !== ATTACHMENT_VALIDATION_REQUESTED) {
        throw new Error("Not an attachment validation event");
      }
      return event as ValidationEvent;
    },
    async handle(event) {
      const config = loadAttachmentConfig();
      const [scope] = await db.execute<{ workspace_id: string | null }>(sql`select c.workspace_id from attachments a join conversations c on c.id=a.conversation_id where a.id=${event.payload.attachmentId}`);
      const operation = (context?: { signal: AbortSignal; assertLease: () => Promise<void>; lease: WorkspaceWorkLease }) =>
        validateAndPromoteAttachment(event.payload.attachmentId, {
          store: options.store ?? getAttachmentObjectStore(), maxBytes: config.maxBytes, ...context,
        });
      if (scope?.workspace_id) {
        await withWorkspaceWorkBudget(scope.workspace_id, "validation", event.payload.attachmentId, operation);
      } else { await operation(); }
    },
  };
}

export function createAttachmentDeletionHandler(options: {
  store?: ObjectStore;
} = {}): DomainEventHandler<DeletionEvent> {
  return {
    type: ATTACHMENT_DELETION_REQUESTED,
    version: ATTACHMENT_EVENT_VERSION,
    parse(value) {
      const event = parseAttachmentLifecycleEvent(value);
      if (event.type !== ATTACHMENT_DELETION_REQUESTED) {
        throw new Error("Not an attachment deletion event");
      }
      return event as DeletionEvent;
    },
    async handle(event) {
      await deleteAttachmentObjects(
        event.payload.attachmentId,
        options.store ?? getAttachmentObjectStore(),
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
    assertLease?: () => Promise<void>;
    lease?: WorkspaceWorkLease;
  },
) {
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
      const pinned = await input.store.headObject({
        key: row.quarantineKey,
        versionId: row.quarantineVersionId,
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
        await rejectAttachment(row, input.store, "stored_object_mismatch");
        return;
      }

      const bytes = await input.store.getObject({
        key: row.quarantineKey,
        versionId: row.quarantineVersionId,
        maxBytes: Math.min(input.maxBytes, row.declaredSizeBytes),
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
        await rejectAttachment(row, input.store, "content_mismatch");
        return;
      }

      const verified = await verifyFileType(bytes, row.declaredMediaType);

      // Do not probe a not-yet-created clean key: S3 intentionally returns
      // AccessDenied rather than NotFound to identities without ListBucket.
      // A retry may copy another version; durable receipts reconcile abandoned
      // copies. Clean version expiration must not remove retained coordinates.
      input.signal?.throwIfAborted();
      await input.assertLease?.();
      const copied = await input.store.copyObject({
        sourceKey: row.quarantineKey,
        sourceVersionId: row.quarantineVersionId,
        destinationKey: row.cleanKey,
        mediaType: verified.storageMediaType,
      });
      if (!copied.versionId) {
        throw new Error(
          "Attachment bucket versioning is required for clean objects",
        );
      }
      await persistObjectCleanup(db, row.id, row.cleanKey, copied.versionId, false);
      let published = false;
      try {
      const clean = await input.store.headObject({
        key: row.cleanKey,
        versionId: copied.versionId,
      });
      if (
        !clean?.versionId ||
        clean.sizeBytes !== row.declaredSizeBytes ||
        clean.checksumSha256Base64 !== expectedChecksumBase64
      ) {
        throw new Error("Promoted clean object failed integrity verification");
      }

      input.signal?.throwIfAborted();
      await input.assertLease?.();
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
            input.lease ? sql`exists(select 1 from workspace_work w
              where w.workspace_id=${input.lease.workspaceId} and w.kind=${input.lease.kind}
              and w.idempotency_key=${input.lease.key} and w.lease_token=${input.lease.token}
              and w.state='running' and w.lease_until>now())` : undefined,
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
      published = true;
      span.setAttribute("thechat.attachment.kind", verified.kind);
      span.setAttribute("thechat.attachment.size_bytes", bytes.byteLength);
      span.setAttribute("thechat.attachment.outcome", "ready");
      span.setAttribute("thechat.attachment.next_status", "ready");
      // Keep the pinned quarantine version until the bucket lifecycle removes it.
      // The signed PUT uses If-None-Match: *, so retaining the object makes the
      // upload URL one-shot for its entire validity window.
      } finally {
        if (!published) await persistObjectCleanup(db, row.id, row.cleanKey, copied.versionId);
      }
    },
    { errorAttributes: { "thechat.attachment.outcome": "failed" } },
  );
}

export async function deleteAttachmentObjects(
  attachmentId: string,
  store: ObjectStore,
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
          await drainAttachmentObjectCleanup(attachmentId, store);
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

        await deletePinnedAttachmentObjects(row, store);

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
) {
  await deletePinnedAttachmentObjects(row, store);
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
) {
  await db.transaction(async (tx) => {
    if (row.cleanKey && row.cleanVersionId) {
      await persistObjectCleanup(tx, row.id, row.cleanKey, row.cleanVersionId);
    }
    if (row.quarantineVersionId) {
      await persistObjectCleanup(tx, row.id, row.quarantineKey, row.quarantineVersionId);
    }
  });
  await drainAttachmentObjectCleanup(row.id, store);
}

async function loadAttachment(id: string) {
  const [row] = await db
    .select()
    .from(attachments)
    .where(eq(attachments.id, id))
    .limit(1);
  return row ?? null;
}
