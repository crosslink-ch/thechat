import { expect, test } from "bun:test";
import crypto from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  attachments,
  conversations,
  users,
  workspaces,
} from "../db/schema";
import {
  closeRealtimeBusForTests,
  LocalRealtimeBus,
  setRealtimeBusForTests,
} from "../realtime";
import { sendMessage } from "../services/messages";
import { createWorkspace } from "../services/workspaces";
import { validateAndPromoteAttachment } from "./handler";
import {
  completeAttachment,
  getAttachmentDownload,
  getAttachment,
  reserveAttachment,
  setAttachmentObjectStoreForTests,
} from "./service";
import type { ObjectStore } from "./object-store";
import { S3ObjectStore } from "./s3-object-store";
import { createClamAvScannerFromEnv } from "./scanner";

const integrationTest =
  process.env.REAL_S3_ATTACHMENT_INTEGRATION === "1" ? test : test.skip;

integrationTest(
  "real S3, ClamAV, PostgreSQL, and message binding flow",
  async () => {
    const region = required("ATTACHMENT_S3_REGION");
    const bucket = required("ATTACHMENT_S3_BUCKET");
    const apiClient = new S3Client({
      region,
      credentials: credentialsFor("ATTACHMENT_API_AWS"),
    });
    const workerClient = new S3Client({
      region,
      credentials: credentialsFor("ATTACHMENT_WORKER_AWS"),
    });
    const apiStore = new S3ObjectStore({ bucket, region, client: apiClient });
    const workerStore = new S3ObjectStore({
      bucket,
      region,
      client: workerClient,
    });

    const suffix = crypto.randomUUID();
    let userId: string | null = null;
    let workspaceId: string | null = null;
    let attachmentId: string | null = null;

    setAttachmentObjectStoreForTests(apiStore);
    await setRealtimeBusForTests(new LocalRealtimeBus());

    try {
      const userName = `Real S3 ${suffix}`;
      const [user] = await db
        .insert(users)
        .values({
          name: userName,
          email: `real-s3-${suffix}@example.com`,
          type: "human",
        })
        .returning({ id: users.id });
      userId = user.id;

      const workspace = await createWorkspace(`Real S3 ${suffix}`, user.id);
      workspaceId = workspace.id;
      const [conversation] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.workspaceId, workspace.id),
            eq(conversations.name, "general"),
          ),
        )
        .limit(1);
      expect(conversation).toBeDefined();

      const bytes = Buffer.from(
        `TheChat real attachment validation ${suffix}\n`,
        "utf8",
      );
      const checksumHex = crypto
        .createHash("sha256")
        .update(bytes)
        .digest("hex");
      const checksumBase64 = Buffer.from(checksumHex, "hex").toString("base64");

      const reservation = await reserveAttachment(user.id, {
        conversationId: conversation.id,
        fileName: "real-s3.txt",
        mediaType: "text/plain",
        sizeBytes: bytes.byteLength,
        checksumSha256: checksumHex,
      });
      const reservedAttachmentId = reservation.attachment.id;
      attachmentId = reservedAttachmentId;
      expect(reservation.upload.method).toBe("PUT");
      const signedHeaders = new URL(
        reservation.upload.url,
      ).searchParams.get("X-Amz-SignedHeaders");
      expect(signedHeaders?.split(";")).toContain("content-length");

      const upload = await fetch(reservation.upload.url, {
        method: "PUT",
        headers: reservation.upload.headers,
        body: bytes,
      });
      if (upload.status !== 200) {
        const errorXml = await upload.text();
        const code = xmlTag(errorXml, "Code") ?? "UnknownS3Error";
        const message = xmlTag(errorXml, "Message") ?? "No message";
        throw new Error(`S3 upload failed (${upload.status}) ${code}: ${message}`);
      }
      expect(upload.status).toBe(200);

      const [reservedRow] = await db
        .select()
        .from(attachments)
        .where(eq(attachments.id, reservedAttachmentId))
        .limit(1);
      const uploadedObject = await apiStore.headObject({
        key: reservedRow.quarantineKey,
      });
      expect(uploadedObject?.sizeBytes).toBe(bytes.byteLength);
      expect(uploadedObject?.contentType).toBe("text/plain");
      expect(uploadedObject?.checksumSha256Base64).toBe(checksumBase64);

      const completed = await completeAttachment(reservedAttachmentId, user.id);
      expect(completed.status).toBe("processing");

      const [processingRow] = await db
        .select()
        .from(attachments)
        .where(eq(attachments.id, reservedAttachmentId))
        .limit(1);
      const workerRead = await workerStore.getObject({
        key: processingRow.quarantineKey,
        versionId: processingRow.quarantineVersionId!,
        maxBytes: 25 * 1024 * 1024,
      });
      expect(Buffer.from(workerRead)).toEqual(bytes);

      await validateAndPromoteAttachment(reservedAttachmentId, {
        store: workerStore,
        scanner: createClamAvScannerFromEnv(25 * 1024 * 1024),
        maxBytes: 25 * 1024 * 1024,
      });
      const ready = await getAttachment(reservedAttachmentId, user.id);
      expect(ready.status).toBe("ready");

      const sent = await sendMessage(
        conversation.id,
        user.id,
        userName,
        "",
        {
          attachmentIds: [reservedAttachmentId],
          clientMessageId: `real-s3-${suffix}`,
        },
      );
      expect(sent.attachments).toHaveLength(1);
      expect(sent.attachments?.[0]).toMatchObject({
        id: reservedAttachmentId,
        fileName: "real-s3.txt",
        mediaType: "text/plain",
      });

      const download = await getAttachmentDownload(reservedAttachmentId, user.id);
      const downloaded = await fetch(download.url);
      expect(downloaded.status).toBe(200);
      expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);

      const [row] = await db
        .select()
        .from(attachments)
        .where(eq(attachments.id, reservedAttachmentId))
        .limit(1);
      expect(row.status).toBe("attached");
      expect(row.cleanKey).toBeTruthy();
      expect(row.cleanVersionId).toBeTruthy();
    } finally {
      if (attachmentId) {
        const [row] = await db
          .select()
          .from(attachments)
          .where(eq(attachments.id, attachmentId))
          .limit(1);
        if (row) {
          await deleteExactVersionQuietly(
            workerStore,
            row.quarantineKey,
            row.quarantineVersionId,
          );
          await deleteExactVersionQuietly(
            workerStore,
            row.cleanKey,
            row.cleanVersionId,
          );
        }
      }
      if (workspaceId) {
        await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      }
      if (userId) {
        await db.delete(users).where(eq(users.id, userId));
      }
      setAttachmentObjectStoreForTests(null);
      await closeRealtimeBusForTests();
      apiClient.destroy();
      workerClient.destroy();
    }
  },
  60_000,
);

function credentialsFor(prefix: string) {
  return {
    accessKeyId: required(`${prefix}_ACCESS_KEY_ID`),
    secretAccessKey: required(`${prefix}_SECRET_ACCESS_KEY`),
    sessionToken: required(`${prefix}_SESSION_TOKEN`),
  };
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for real S3 integration`);
  return value;
}

function xmlTag(xml: string, tag: string) {
  const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return match?.[1] ?? null;
}

async function deleteExactVersionQuietly(
  store: ObjectStore,
  key: string | null,
  versionId: string | null,
) {
  if (!key || !versionId) return;
  try {
    await store.deleteObject({ key, versionId });
  } catch {
    // Best effort in test teardown; bucket lifecycle is the final backstop.
  }
}
