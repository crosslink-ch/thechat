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
import {
  UnsafeAttachmentError,
  verifyFileType,
} from "./file-validation";
import type { ObjectStore } from "./object-store";
import type { AttachmentScanner } from "./scanner";
import { createClamAvScannerFromEnv } from "./scanner";
import { getAttachmentObjectStore } from "./service";

type ValidationEvent = AttachmentLifecycleEvent & {
  type: typeof ATTACHMENT_VALIDATION_REQUESTED;
};
type DeletionEvent = AttachmentLifecycleEvent & {
  type: typeof ATTACHMENT_DELETION_REQUESTED;
};

const attachmentValidationConcurrency = boundedConcurrency(
  process.env.ATTACHMENT_VALIDATION_CONCURRENCY,
);
const validationWaiters: Array<() => void> = [];
let activeValidations = 0;

export function createAttachmentValidationHandler(options: {
  store?: ObjectStore;
  scanner?: AttachmentScanner;
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
      await withValidationSlot(() =>
        validateAndPromoteAttachment(event.payload.attachmentId, {
          store: options.store ?? getAttachmentObjectStore(),
          scanner:
            options.scanner ?? createClamAvScannerFromEnv(config.maxBytes),
          maxBytes: config.maxBytes,
        }),
      );
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

async function withValidationSlot<T>(operation: () => Promise<T>) {
  if (activeValidations >= attachmentValidationConcurrency) {
    await new Promise<void>((resolve) => validationWaiters.push(resolve));
  }
  activeValidations += 1;
  try {
    return await operation();
  } finally {
    activeValidations -= 1;
    validationWaiters.shift()?.();
  }
}

function boundedConcurrency(raw: string | undefined) {
  const parsed = Number.parseInt(raw ?? "1", 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(parsed, 8));
}

export async function validateAndPromoteAttachment(
  attachmentId: string,
  input: {
    store: ObjectStore;
    scanner: AttachmentScanner;
    maxBytes: number;
  },
) {
  return withSpan(
    "attachment.validate_promote",
    {
      "messaging.system": "thechat",
      "thechat.attachment_id": attachmentId,
    },
    async (span) => {
      const row = await loadAttachment(attachmentId);
      if (!row) return;
      if (row.status === "ready") return;
      if (row.status !== "processing") return;
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
        await rejectAttachment(row, input.store, "content_mismatch");
        return;
      }

      let verified;
      try {
        verified = await verifyFileType(bytes, row.declaredMediaType);
      } catch (error) {
        if (error instanceof UnsafeAttachmentError) {
          await rejectAttachment(row, input.store, error.reason);
          return;
        }
        throw error;
      }

      const scan = await input.scanner.scan(bytes);
      if (scan.status === "infected") {
        await rejectAttachment(row, input.store, "malware_detected");
        return;
      }

      // Do not probe a not-yet-created clean key: S3 intentionally returns
      // AccessDenied rather than NotFound to identities without ListBucket.
      // A retry can safely create another version at this deterministic key;
      // the bucket lifecycle removes superseded versions.
      const copied = await input.store.copyObject({
        sourceKey: row.quarantineKey,
        sourceVersionId: row.quarantineVersionId,
        destinationKey: row.cleanKey,
        mediaType: verified.mediaType,
      });
      if (!copied.versionId) {
        throw new Error(
          "Attachment bucket versioning is required for clean objects",
        );
      }
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
        await input.store.deleteObject({
          key: row.cleanKey,
          versionId: clean.versionId,
        });
        return;
      }
      span.setAttribute("thechat.attachment.kind", verified.kind);
      span.setAttribute("thechat.attachment.size_bytes", bytes.byteLength);
      // Keep the pinned quarantine version until the bucket lifecycle removes it.
      // The signed PUT uses If-None-Match: *, so retaining the object makes the
      // upload URL one-shot for its entire validity window.
    },
  );
}

export async function deleteAttachmentObjects(
  attachmentId: string,
  store: ObjectStore,
) {
  const row = await loadAttachment(attachmentId);
  if (!row || row.status === "deleted") return;
  if (
    row.status !== "deleting" &&
    row.status !== "rejected"
  ) {
    return;
  }

  if (row.cleanKey && row.cleanVersionId) {
    await store.deleteObject({
      key: row.cleanKey,
      versionId: row.cleanVersionId,
    });
  }

  const now = new Date();
  await db
    .update(attachments)
    .set({
      ...(row.status === "rejected" ? {} : { status: "deleted" }),
      deletedAt: now,
      updatedAt: now,
    })
    .where(eq(attachments.id, row.id));
}

async function rejectAttachment(
  row: typeof attachments.$inferSelect,
  store: ObjectStore,
  reason: string,
) {
  if (row.cleanKey && row.cleanVersionId) {
    await store.deleteObject({
      key: row.cleanKey,
      versionId: row.cleanVersionId,
    });
  }
  const now = new Date();
  await db
    .update(attachments)
    .set({
      status: "rejected",
      failureReason: reason,
      rejectedAt: now,
      deletedAt: now,
      updatedAt: now,
    })
    .where(eq(attachments.id, row.id));
}

async function loadAttachment(id: string) {
  const [row] = await db
    .select()
    .from(attachments)
    .where(eq(attachments.id, id))
    .limit(1);
  return row ?? null;
}
