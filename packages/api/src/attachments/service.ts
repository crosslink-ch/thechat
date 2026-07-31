import crypto from "node:crypto";
import { SpanStatusCode, type Span } from "@opentelemetry/api";
import { and, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import { db } from "../db";
import {
  attachments,
  bots,
  conversationParticipants,
  users,
} from "../db/schema";
import { enqueueDomainEvent } from "../events/outbox";
import { withSpan } from "../observability";
import { ServiceError } from "../services/errors";
import { loadAttachmentConfig } from "./config";
import {
  ATTACHMENT_DELETION_REQUESTED,
  ATTACHMENT_VALIDATION_REQUESTED,
  createAttachmentLifecycleEvent,
} from "./events";
import {
  isAllowedDeclaredMediaType,
  normalizeDeclaredMediaType,
} from "./file-validation";
import type { ObjectStore } from "./object-store";
import { isInlineRaster, toAttachmentView } from "./public";
import { createS3ObjectStoreFromEnv } from "./s3-object-store";

type AttachmentStatus = typeof attachments.$inferSelect.status;
type AttachmentQueryExecutor = Pick<typeof db, "select">;

let objectStore: ObjectStore | null = null;

export function setAttachmentObjectStoreForTests(store: ObjectStore | null) {
  objectStore = store;
}

export function getAttachmentObjectStore() {
  objectStore ??= createS3ObjectStoreFromEnv();
  return objectStore;
}

export async function reserveAttachment(
  userId: string,
  input: {
    conversationId: string;
    fileName: string;
    mediaType: string;
    sizeBytes: number;
    checksumSha256: string;
  },
  options: { store?: ObjectStore } = {},
) {
  return withSpan(
    "attachment.reserve",
    {
      "messaging.system": "thechat",
      "thechat.attachment.size_bytes": input.sizeBytes,
    },
    async (span) => {
      try {
        const config = loadAttachmentConfig();
        await requireAttachmentActor(userId);
        const fileName = sanitizeFileName(input.fileName);
        const mediaType = normalizeDeclaredMediaType(input.mediaType);
        const checksum = normalizeSha256(input.checksumSha256);
        if (!isAllowedDeclaredMediaType(mediaType)) {
          throw new ServiceError("This file type is not supported", 400);
        }
        span.setAttribute("thechat.attachment.media_type", mediaType);
        if (
          !Number.isSafeInteger(input.sizeBytes) ||
          input.sizeBytes < 1 ||
          input.sizeBytes > config.maxBytes
        ) {
          throw new ServiceError(
            `Attachment size must be between 1 and ${config.maxBytes} bytes`,
            400,
          );
        }
        await requireParticipant(input.conversationId, userId);
        await enforceDraftQuota(
          db,
          input.conversationId,
          userId,
          input.sizeBytes,
          config.maxPerMessage,
          config.draftQuotaBytes,
        );

        const id = crypto.randomUUID();
        const quarantineKey = `quarantine/${crypto.randomUUID()}`;
        const cleanKey = `clean/${crypto.randomUUID()}`;
        const store = options.store ?? getAttachmentObjectStore();
        const upload = await store.createUploadRequest({
          key: quarantineKey,
          mediaType,
          sizeBytes: input.sizeBytes,
          checksumSha256Base64: checksum.base64,
          expiresInSeconds: config.uploadTtlSeconds,
        });
        const expiresAt = new Date(
          Date.now() + config.unattachedTtlSeconds * 1000,
        );
        const [row] = await db.transaction(async (tx) => {
          // The byte quota is per uploader across conversations, so serialize
          // every reservation for that uploader rather than only this chat.
          const lockKey = `attachment-draft:${userId}`;
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
          );
          await enforceDraftQuota(
            tx,
            input.conversationId,
            userId,
            input.sizeBytes,
            config.maxPerMessage,
            config.draftQuotaBytes,
          );
          return tx
            .insert(attachments)
            .values({
              id,
              conversationId: input.conversationId,
              uploaderId: userId,
              fileName,
              declaredMediaType: mediaType,
              declaredSizeBytes: input.sizeBytes,
              declaredChecksumSha256: checksum.hex,
              quarantineKey,
              cleanKey,
              uploadExpiresAt: upload.expiresAt,
              expiresAt,
            })
            .returning();
        });
        span.setAttribute("thechat.attachment.outcome", "reserved");

        return {
          attachment: toAttachmentView(row, { includeStatus: true }),
          upload: {
            method: "PUT" as const,
            url: upload.url,
            headers: upload.headers,
            expiresAt: upload.expiresAt.toISOString(),
          },
        };
      } catch (error) {
        setAttachmentBusinessFailure(span, error);
        throw error;
      }
    },
  );
}

export async function completeAttachment(
  attachmentId: string,
  userId: string,
  options: { store?: ObjectStore } = {},
) {
  return withSpan(
    "attachment.complete",
    {},
    async (span) => {
      try {
        const result = await completeAttachmentOperation(
          attachmentId,
          userId,
          options,
        );
        if (result.attachment.status) {
          span.setAttribute(
            "thechat.attachment.status",
            result.attachment.status,
          );
        }
        span.setAttribute("thechat.attachment.outcome", result.outcome);
        return result.attachment;
      } catch (error) {
        setAttachmentBusinessFailure(span, error);
        throw error;
      }
    },
  );
}

async function completeAttachmentOperation(
  attachmentId: string,
  userId: string,
  options: { store?: ObjectStore } = {},
) {
  await requireAttachmentActor(userId);
  const row = await loadAttachment(attachmentId);
  if (!row) throw new ServiceError("Attachment not found", 404);
  if (row.uploaderId !== userId) {
    throw new ServiceError(
      "Only the uploader can complete this attachment",
      403,
    );
  }
  await requireParticipant(row.conversationId, userId);
  if (
    row.status === "processing" ||
    row.status === "ready" ||
    row.status === "attached"
  ) {
    return {
      attachment: toAttachmentView(row, { includeStatus: true }),
      outcome: `already_${row.status}`,
    };
  }
  if (row.status !== "pending_upload") {
    throw new ServiceError("Attachment is no longer uploadable", 409);
  }
  if (row.uploadExpiresAt.getTime() < Date.now()) {
    await requestAttachmentDeletion(row, userId);
    throw new ServiceError("Attachment upload reservation expired", 409);
  }

  const store = options.store ?? getAttachmentObjectStore();
  let object;
  try {
    object = await store.headObject({ key: row.quarantineKey });
  } catch (error) {
    if (s3StatusCode(error) === 403) {
      throw new ServiceError("Uploaded object was not found", 409);
    }
    throw error;
  }
  if (!object) {
    throw new ServiceError("Uploaded object was not found", 409);
  }
  const mismatch =
    !object.versionId ||
    object.sizeBytes !== row.declaredSizeBytes ||
    object.checksumSha256Base64 !==
      Buffer.from(row.declaredChecksumSha256, "hex").toString("base64") ||
    normalizeDeclaredMediaType(object.contentType ?? "") !==
      row.declaredMediaType;
  if (mismatch) {
    await rejectAndDeleteUnverifiedAttachment(row, userId, object.versionId);
    throw new ServiceError(
      "Uploaded object metadata does not match the reservation",
      409,
    );
  }

  let validationEnqueued = false;
  const updated = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(attachments)
      .where(eq(attachments.id, attachmentId))
      .for("update")
      .limit(1);
    if (!current) throw new ServiceError("Attachment not found", 404);
    if (current.status !== "pending_upload") return current;

    const now = new Date();
    const [processing] = await tx
      .update(attachments)
      .set({
        status: "processing",
        quarantineVersionId: object.versionId,
        processingAt: now,
        failureReason: null,
        updatedAt: now,
      })
      .where(eq(attachments.id, current.id))
      .returning();
    await enqueueDomainEvent(
      tx,
      createAttachmentLifecycleEvent(
        ATTACHMENT_VALIDATION_REQUESTED,
        current.id,
        userId,
      ),
      { partitionKey: `attachment:${current.id}` },
    );
    validationEnqueued = true;
    return processing;
  });
  return {
    attachment: toAttachmentView(updated, { includeStatus: true }),
    outcome: validationEnqueued
      ? "validation_enqueued"
      : `already_${updated.status}`,
  };
}

export async function getAttachment(attachmentId: string, userId: string) {
  return withSpan(
    "attachment.status",
    {},
    async (span) => {
      try {
        await requireAttachmentActor(userId);
        const row = await loadAttachment(attachmentId);
        if (!row) throw new ServiceError("Attachment not found", 404);
        await authorizeAttachmentRead(row, userId);
        span.setAttribute("thechat.attachment.status", row.status);
        span.setAttribute("thechat.attachment.outcome", "loaded");
        return toAttachmentView(row, { includeStatus: true });
      } catch (error) {
        setAttachmentBusinessFailure(span, error);
        throw error;
      }
    },
  );
}

export async function getAttachmentDownload(
  attachmentId: string,
  userId: string,
  options: {
    store?: ObjectStore;
    disposition?: "attachment" | "inline";
  } = {},
) {
  return withSpan(
    "attachment.download.authorize",
    {
      "thechat.attachment.disposition": options.disposition ?? "attachment",
    },
    async (span) => {
      try {
        const result = await getAttachmentDownloadOperation(
          attachmentId,
          userId,
          options,
        );
        span.setAttribute("thechat.attachment.outcome", "authorized");
        return result;
      } catch (error) {
        setAttachmentBusinessFailure(span, error);
        throw error;
      }
    },
  );
}

async function getAttachmentDownloadOperation(
  attachmentId: string,
  userId: string,
  options: {
    store?: ObjectStore;
    disposition?: "attachment" | "inline";
  } = {},
) {
  await requireAttachmentActor(userId);
  const row = await loadAttachment(attachmentId);
  if (!row) throw new ServiceError("Attachment not found", 404);
  await requireParticipant(row.conversationId, userId);
  if (
    row.status !== "attached" ||
    !row.cleanKey ||
    !row.cleanVersionId ||
    !row.verifiedMediaType
  ) {
    throw new ServiceError("Attachment content is not available", 409);
  }
  const config = loadAttachmentConfig();
  const request = await (
    options.store ?? getAttachmentObjectStore()
  ).createDownloadRequest({
    key: row.cleanKey,
    versionId: row.cleanVersionId,
    mediaType: row.verifiedMediaType,
    contentDisposition: safeContentDisposition(
      row.fileName,
      options.disposition === "inline" && isInlineRaster(row.verifiedMediaType)
        ? "inline"
        : "attachment",
    ),
    expiresInSeconds: config.downloadTtlSeconds,
  });
  return {
    url: request.url,
    expiresAt: request.expiresAt.toISOString(),
  };
}

export async function deleteAttachment(attachmentId: string, userId: string) {
  return withSpan(
    "attachment.delete.request",
    {},
    async (span) => {
      try {
        const result = await deleteAttachmentOperation(attachmentId, userId);
        span.setAttribute("thechat.attachment.outcome", result.outcome);
        return result.response;
      } catch (error) {
        setAttachmentBusinessFailure(span, error);
        throw error;
      }
    },
  );
}

async function deleteAttachmentOperation(attachmentId: string, userId: string) {
  await requireAttachmentActor(userId);
  const row = await loadAttachment(attachmentId);
  if (!row) {
    return { response: { ok: true }, outcome: "already_absent" };
  }
  if (row.uploaderId !== userId) {
    throw new ServiceError("Only the uploader can delete this attachment", 403);
  }
  await requireParticipant(row.conversationId, userId);
  if (row.status === "attached") {
    throw new ServiceError(
      "Attached files cannot be deleted from the draft API",
      409,
    );
  }
  if (row.status === "deleted" || row.status === "deleting") {
    return {
      response: { ok: true },
      outcome:
        row.status === "deleted" ? "already_deleted" : "already_deleting",
    };
  }
  await requestAttachmentDeletion(row, userId);
  return { response: { ok: true }, outcome: "deletion_requested" };
}

export async function requestExpiredAttachmentCleanup(
  limit = loadAttachmentConfig().cleanupBatchSize,
) {
  const expired = await db
    .select()
    .from(attachments)
    .where(
      and(
        inArray(attachments.status, ["pending_upload", "processing", "ready"]),
        lte(attachments.expiresAt, new Date()),
      ),
    )
    .limit(limit);

  let requested = 0;
  for (const row of expired) {
    const changed = await db.transaction(async (tx) => {
      const now = new Date();
      const [deleting] = await tx
        .update(attachments)
        .set({ status: "deleting", deletingAt: now, updatedAt: now })
        .where(
          and(
            eq(attachments.id, row.id),
            inArray(attachments.status, [
              "pending_upload",
              "processing",
              "ready",
            ]),
          ),
        )
        .returning({ id: attachments.id });
      if (!deleting) return false;
      await enqueueDomainEvent(
        tx,
        createAttachmentLifecycleEvent(
          ATTACHMENT_DELETION_REQUESTED,
          row.id,
          "attachment-cleanup",
        ),
        { partitionKey: `attachment:${row.id}` },
      );
      return true;
    });
    if (changed) requested += 1;
  }
  return requested;
}

async function requestAttachmentDeletion(
  row: typeof attachments.$inferSelect,
  actorId: string,
) {
  await db.transaction(async (tx) => {
    const now = new Date();
    const [deleting] = await tx
      .update(attachments)
      .set({ status: "deleting", deletingAt: now, updatedAt: now })
      .where(
        and(
          eq(attachments.id, row.id),
          inArray(attachments.status, [
            "pending_upload",
            "processing",
            "ready",
            "rejected",
          ]),
        ),
      )
      .returning({ id: attachments.id });
    if (!deleting) return;
    await enqueueDomainEvent(
      tx,
      createAttachmentLifecycleEvent(
        ATTACHMENT_DELETION_REQUESTED,
        row.id,
        actorId,
      ),
      { partitionKey: `attachment:${row.id}` },
    );
  });
}

async function rejectAndDeleteUnverifiedAttachment(
  row: typeof attachments.$inferSelect,
  actorId: string,
  versionId: string | null,
) {
  await db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .update(attachments)
      .set({
        status: "rejected",
        quarantineVersionId: versionId,
        rejectedAt: now,
        failureReason: "metadata_mismatch",
        updatedAt: now,
      })
      .where(eq(attachments.id, row.id));
    await enqueueDomainEvent(
      tx,
      createAttachmentLifecycleEvent(
        ATTACHMENT_DELETION_REQUESTED,
        row.id,
        actorId,
      ),
      { partitionKey: `attachment:${row.id}` },
    );
  });
}

async function authorizeAttachmentRead(
  row: typeof attachments.$inferSelect,
  userId: string,
) {
  if (row.status !== "attached") {
    if (row.uploaderId !== userId) {
      throw new ServiceError("Attachment is visible only to its uploader", 403);
    }
    await requireParticipant(row.conversationId, userId);
    return;
  }
  await requireParticipant(row.conversationId, userId);
}

async function enforceDraftQuota(
  executor: AttachmentQueryExecutor,
  conversationId: string,
  userId: string,
  addedBytes: number,
  maxPerMessage: number,
  quotaBytes: number,
) {
  const quotaEligible = or(
    inArray(attachments.status, ["pending_upload", "processing", "ready"]),
    gt(attachments.uploadExpiresAt, new Date()),
  );
  const [conversationUsage] = await executor
    .select({
      count: sql<number>`count(*)::int`,
    })
    .from(attachments)
    .where(
      and(
        eq(attachments.conversationId, conversationId),
        eq(attachments.uploaderId, userId),
        quotaEligible,
      ),
    );
  if ((conversationUsage?.count ?? 0) >= maxPerMessage * 2) {
    throw new ServiceError("Too many open attachment drafts", 429);
  }

  const [userUsage] = await executor
    .select({
      bytes: sql<number>`coalesce(sum(${attachments.declaredSizeBytes}), 0)::int`,
    })
    .from(attachments)
    .where(and(eq(attachments.uploaderId, userId), quotaEligible));
  if ((userUsage?.bytes ?? 0) + addedBytes > quotaBytes) {
    throw new ServiceError("Attachment draft quota exceeded", 429);
  }
}

async function requireParticipant(conversationId: string, userId: string) {
  const [participant] = await db
    .select({ userId: conversationParticipants.userId })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.userId, userId),
      ),
    )
    .limit(1);
  if (!participant) {
    throw new ServiceError(
      "You are not a participant of this conversation",
      403,
    );
  }
}

async function requireAttachmentActor(userId: string) {
  const [actor] = await db
    .select({
      type: users.type,
      attachmentAccess: bots.attachmentAccess,
    })
    .from(users)
    .leftJoin(bots, eq(bots.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);
  if (!actor) throw new ServiceError("Authentication required", 401);
  if (actor.type === "bot" && actor.attachmentAccess !== true) {
    throw new ServiceError(
      "Attachment access is not enabled for this bot token",
      403,
    );
  }
  return actor;
}

async function loadAttachment(id: string) {
  const [row] = await db
    .select()
    .from(attachments)
    .where(eq(attachments.id, id))
    .limit(1);
  return row ?? null;
}

export function sanitizeFileName(value: string) {
  const normalized = value
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/[\\/]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || normalized === "." || normalized === "..") {
    throw new ServiceError("A valid file name is required", 400);
  }
  return [...normalized].slice(0, 255).join("");
}

export function safeContentDisposition(
  fileName: string,
  disposition: "attachment" | "inline" = "attachment",
) {
  const ascii =
    fileName
      .normalize("NFKD")
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\]/g, "_")
      .slice(0, 150) || "attachment";
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function setAttachmentBusinessFailure(span: Span, error: unknown) {
  const status = error instanceof ServiceError ? error.status : 500;
  span.setAttribute(
    "thechat.attachment.outcome",
    status >= 500 ? "failed" : "rejected",
  );
  span.setAttribute(
    "thechat.attachment.failure_reason",
    status === 400
      ? "invalid_request"
      : status === 401
        ? "unauthenticated"
        : status === 403
          ? "forbidden"
          : status === 404
            ? "not_found"
            : status === 409
              ? "lifecycle_conflict"
              : status === 429
                ? "quota_exceeded"
                : "system_failure",
  );
  if (status >= 500) {
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
}

function s3StatusCode(error: unknown) {
  if (!error || typeof error !== "object") return undefined;
  return (error as { $metadata?: { httpStatusCode?: number } }).$metadata
    ?.httpStatusCode;
}

export function normalizeSha256(value: string) {
  const trimmed = value.trim();
  if (/^[a-fA-F0-9]{64}$/.test(trimmed)) {
    const hex = trimmed.toLowerCase();
    return { hex, base64: Buffer.from(hex, "hex").toString("base64") };
  }
  if (/^[A-Za-z0-9+/]{43}=$/.test(trimmed)) {
    const bytes = Buffer.from(trimmed, "base64");
    if (bytes.byteLength === 32) {
      return { hex: bytes.toString("hex"), base64: trimmed };
    }
  }
  throw new ServiceError(
    "checksumSha256 must be a SHA-256 hex or base64 digest",
    400,
  );
}

export const UNATTACHED_ATTACHMENT_STATUSES: AttachmentStatus[] = [
  "pending_upload",
  "processing",
  "ready",
];
