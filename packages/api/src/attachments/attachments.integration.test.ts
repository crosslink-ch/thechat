import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import crypto from "node:crypto";
import { Elysia } from "elysia";
import { eq, inArray } from "drizzle-orm";
import { authRoutes } from "../auth";
import { botRoutes } from "../bots";
import { hermesPlatformRoutes } from "../hermes-platform";
import { conversationRoutes } from "../conversations";
import { db } from "../db";
import {
  attachments,
  messages,
  users,
  workspaces,
} from "../db/schema";
import { inviteRoutes } from "../invites";
import { messageRoutes } from "../messages";
import {
  closeRealtimeBusForTests,
  LocalRealtimeBus,
  setRealtimeBusForTests,
} from "../realtime";
import { workspaceRoutes } from "../workspaces";
import { attachmentRoutes } from "./index";
import type {
  ObjectStore,
  PresignedRequest,
  StoredObjectMetadata,
} from "./object-store";
import {
  deleteAttachmentObjects,
  validateAndPromoteAttachment,
} from "./handler";
import { setAttachmentObjectStoreForTests } from "./service";

const app = new Elysia()
  .use(authRoutes)
  .use(workspaceRoutes)
  .use(inviteRoutes)
  .use(conversationRoutes)
  .use(messageRoutes)
  .use(attachmentRoutes)
  .use(botRoutes)
  .use(hermesPlatformRoutes);

const createdWorkspaceIds: string[] = [];
const createdUserIds: string[] = [];
let store: ReturnType<typeof createFakeObjectStore>;

beforeAll(async () => {
  store = createFakeObjectStore();
  setAttachmentObjectStoreForTests(store);
  await setRealtimeBusForTests(new LocalRealtimeBus());
});

afterAll(async () => {
  setAttachmentObjectStoreForTests(null);
  await closeRealtimeBusForTests();
  if (createdWorkspaceIds.length > 0) {
    await db
      .delete(workspaces)
      .where(inArray(workspaces.id, createdWorkspaceIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

async function request(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await response.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Keep non-JSON bodies visible in assertion failures.
  }
  return { status: response.status, body: parsed };
}

async function register(name: string) {
  const response = await request("POST", "/auth/register", {
    name,
    email: `${crypto.randomUUID()}@attachments.test`,
    password: "password123",
  });
  expect(response.status).toBe(200);
  createdUserIds.push(response.body.user.id);
  return {
    token: response.body.accessToken as string,
    user: response.body.user as { id: string; email: string },
  };
}

async function workspaceWithMembers(owner: Awaited<ReturnType<typeof register>>, member?: Awaited<ReturnType<typeof register>>) {
  const created = await request(
    "POST",
    "/workspaces/create",
    { name: `Attachments ${crypto.randomUUID()}` },
    owner.token,
  );
  expect(created.status).toBe(200);
  createdWorkspaceIds.push(created.body.id);
  if (member) {
    const invitation = await request(
      "POST",
      "/invites/create",
      { workspaceId: created.body.id, email: member.user.email },
      owner.token,
    );
    expect(invitation.status).toBe(200);
    expect(
      (
        await request(
          "POST",
          "/invites/accept",
          { inviteId: invitation.body.id },
          member.token,
        )
      ).status,
    ).toBe(200);
  }
  const detail = await request(
    "GET",
    `/workspaces/${created.body.id}`,
    undefined,
    owner.token,
  );
  expect(detail.status).toBe(200);
  return {
    workspaceId: created.body.id as string,
    conversationId: detail.body.channels[0].id as string,
  };
}

describe("attachment lifecycle", () => {
  test("authorizes, validates, atomically binds, replays, and downloads without leaking storage coordinates", async () => {
    const owner = await register("Attachment owner");
    const member = await register("Attachment member");
    const stranger = await register("Attachment stranger");
    const { conversationId } = await workspaceWithMembers(owner, member);
    const bytes = new TextEncoder().encode("safe attachment contents");
    const checksum = crypto.createHash("sha256").update(bytes).digest("hex");

    const reserved = await request(
      "POST",
      "/attachments",
      {
        conversationId,
        fileName: "../safe report.txt",
        mediaType: "text/plain",
        sizeBytes: bytes.byteLength,
        checksumSha256: checksum,
      },
      owner.token,
    );
    expect(reserved.status).toBe(200);
    expect(JSON.stringify(reserved.body)).not.toContain("quarantine/");
    expect(JSON.stringify(reserved.body)).not.toContain("clean/");
    expect(reserved.body.attachment.fileName).toBe(".._safe report.txt");
    const attachmentId = reserved.body.attachment.id as string;
    store.acceptLatestUpload(bytes);

    const completed = await request(
      "POST",
      `/attachments/${attachmentId}/complete`,
      {},
      owner.token,
    );
    expect(completed.status).toBe(200);
    expect(completed.body.status).toBe("processing");

    await validateAndPromoteAttachment(attachmentId, {
      store,
      scanner: { scan: async () => ({ status: "clean" as const }) },
      maxBytes: 25 * 1024 * 1024,
    });
    const ready = await request(
      "GET",
      `/attachments/${attachmentId}`,
      undefined,
      owner.token,
    );
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe("ready");

    const clientMessageId = crypto.randomUUID();
    const sendPayload = {
      content: "",
      attachmentIds: [attachmentId],
      clientMessageId,
    };
    setRealtimeBusForTests({
      publish: async () => {
        throw new Error("realtime unavailable after commit");
      },
      subscribe: async () => async () => undefined,
    });
    const [sent, concurrentReplay] = await Promise.all([
      request(
        "POST",
        `/messages/${conversationId}`,
        sendPayload,
        owner.token,
      ),
      request(
        "POST",
        `/messages/${conversationId}`,
        sendPayload,
        owner.token,
      ),
    ]).finally(async () => {
      await setRealtimeBusForTests(new LocalRealtimeBus());
    });
    expect(sent.status).toBe(200);
    expect(concurrentReplay.status).toBe(200);
    expect(concurrentReplay.body.id).toBe(sent.body.id);
    expect(sent.body.content).toBe("");
    expect(sent.body.attachments).toEqual([
      expect.objectContaining({
        id: attachmentId,
        fileName: ".._safe report.txt",
        mediaType: "text/plain",
        sizeBytes: bytes.byteLength,
        kind: "file",
        contentPath: `/attachments/${attachmentId}/content`,
      }),
    ]);
    expect(JSON.stringify(sent.body)).not.toContain("quarantine/");
    expect(JSON.stringify(sent.body)).not.toContain("clean/");
    expect(JSON.stringify(sent.body)).not.toContain("X-Amz-");

    const replay = await request(
      "POST",
      `/messages/${conversationId}`,
      { content: "", attachmentIds: [attachmentId], clientMessageId },
      owner.token,
    );
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(sent.body.id);

    const changedReplay = await request(
      "POST",
      `/messages/${conversationId}`,
      {
        content: "changed",
        attachmentIds: [attachmentId],
        clientMessageId,
      },
      owner.token,
    );
    expect(changedReplay.status).toBe(409);

    const reused = await request(
      "POST",
      `/messages/${conversationId}`,
      {
        content: "reuse",
        attachmentIds: [attachmentId],
        clientMessageId: crypto.randomUUID(),
      },
      owner.token,
    );
    expect(reused.status).toBe(409);

    const [messageCount] = await db
      .select({ count: messages.id })
      .from(messages)
      .where(eq(messages.id, sent.body.id));
    expect(messageCount?.count).toBe(sent.body.id);

    const history = await request(
      "GET",
      `/messages/${conversationId}`,
      undefined,
      member.token,
    );
    expect(history.status).toBe(200);
    expect(history.body.find((message: any) => message.id === sent.body.id)?.attachments)
      .toEqual(sent.body.attachments);

    const memberDownload = await request(
      "GET",
      `/attachments/${attachmentId}/download`,
      undefined,
      member.token,
    );
    expect(memberDownload.status).toBe(200);
    expect(memberDownload.body.url).toContain("https://download.invalid/");

    const strangerDownload = await request(
      "GET",
      `/attachments/${attachmentId}/download`,
      undefined,
      stranger.token,
    );
    expect(strangerDownload.status).toBe(403);
    expect(
      (
        await request(
          "DELETE",
          `/attachments/${attachmentId}`,
          undefined,
          owner.token,
        )
      ).status,
    ).toBe(409);
  });

  test("existing bot tokens are denied until their owner explicitly grants lower-quota attachment access", async () => {
    const owner = await register("Bot attachment owner");
    const { workspaceId, conversationId } = await workspaceWithMembers(owner);
    const created = await request(
      "POST",
      "/bots/create",
      {
        name: "Scoped Hermes",
        kind: "hermes",
        workspaceId,
        attachmentAccess: false,
      },
      owner.token,
    );
    expect(created.status).toBe(200);
    createdUserIds.push(created.body.userId);
    const botToken = created.body.apiKey as string;
    const checksum = crypto.createHash("sha256").update("x").digest("hex");

    const denied = await request(
      "POST",
      "/attachments",
      {
        conversationId,
        fileName: "bot.txt",
        mediaType: "text/plain",
        sizeBytes: 1,
        checksumSha256: checksum,
      },
      botToken,
    );
    expect(denied.status).toBe(403);

    const enabled = await request(
      "PATCH",
      `/bots/${created.body.id}`,
      { attachmentAccess: true },
      owner.token,
    );
    expect(enabled.status).toBe(200);
    expect(enabled.body.attachmentAccess).toBe(true);

    const oversized = await request(
      "POST",
      "/attachments",
      {
        conversationId,
        fileName: "oversized.txt",
        mediaType: "text/plain",
        sizeBytes: 10 * 1024 * 1024 + 1,
        checksumSha256: checksum,
      },
      botToken,
    );
    expect(oversized.status).toBe(400);

    const botBytes = new TextEncoder().encode("x");
    const allowed = await request(
      "POST",
      "/attachments",
      {
        conversationId,
        fileName: "bot.txt",
        mediaType: "text/plain",
        sizeBytes: botBytes.byteLength,
        checksumSha256: checksum,
      },
      botToken,
    );
    expect(allowed.status).toBe(200);
    store.acceptLatestUpload(botBytes);
    const botAttachmentId = allowed.body.attachment.id as string;
    expect(
      (
        await request(
          "POST",
          `/attachments/${botAttachmentId}/complete`,
          undefined,
          botToken,
        )
      ).status,
    ).toBe(200);
    await validateAndPromoteAttachment(botAttachmentId, {
      store,
      scanner: { scan: async () => ({ status: "clean" as const }) },
      maxBytes: 10 * 1024 * 1024,
    });

    const command = {
      conversationId,
      content: "",
      attachmentIds: [botAttachmentId],
      platformMessageId: "attachment-retry-1",
    };
    const firstMessage = await request(
      "POST",
      "/hermes-platform/messages",
      command,
      botToken,
    );
    expect(firstMessage.status).toBe(200);
    expect(firstMessage.body.duplicate).toBe(false);

    const retryMessage = await request(
      "POST",
      "/hermes-platform/messages",
      command,
      botToken,
    );
    expect(retryMessage.status).toBe(200);
    expect(retryMessage.body).toEqual({
      messageId: firstMessage.body.messageId,
      threadId: null,
      duplicate: true,
    });

    const conflictingReplay = await request(
      "POST",
      "/hermes-platform/messages",
      { ...command, content: "different command" },
      botToken,
    );
    expect(conflictingReplay.status).toBe(409);

    const storedMessages = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.clientMessageId, command.platformMessageId));
    expect(storedMessages).toHaveLength(1);

    expect(
      (
        await request(
          "PATCH",
          `/bots/${created.body.id}`,
          { attachmentAccess: false },
          owner.token,
        )
      ).status,
    ).toBe(200);
    const botHistory = await request(
      "GET",
      `/messages/${conversationId}`,
      undefined,
      botToken,
    );
    expect(botHistory.status).toBe(200);
    expect(
      (botHistory.body as Array<{ attachments?: unknown[] }>).every(
        (message) => (message.attachments?.length ?? 0) === 0,
      ),
    ).toBe(true);
    expect(
      (
        await request(
          "GET",
          `/attachments/${allowed.body.attachment.id}`,
          undefined,
          botToken,
        )
      ).status,
    ).toBe(403);
  });

  test("maps concealed missing S3 objects to a completion conflict", async () => {
    const owner = await register(`Missing ${crypto.randomUUID()}`);
    const { conversationId } = await workspaceWithMembers(owner);
    const reserved = await request(
      "POST",
      "/attachments",
      {
        conversationId,
        fileName: "missing.txt",
        mediaType: "text/plain",
        sizeBytes: 1,
        checksumSha256: "0".repeat(64),
      },
      owner.token,
    );
    expect(reserved.status).toBe(200);

    store.headError = { $metadata: { httpStatusCode: 403 } };
    try {
      const completed = await request(
        "POST",
        `/attachments/${reserved.body.attachment.id}/complete`,
        undefined,
        owner.token,
      );
      expect(completed.status).toBe(409);
      expect(completed.body.error).toBe("Uploaded object was not found");
    } finally {
      store.headError = null;
    }
  });

  test("deletes an unuploaded reservation without probing concealed S3 keys", async () => {
    const owner = await register(`Delete ${crypto.randomUUID()}`);
    const { conversationId } = await workspaceWithMembers(owner);
    const reserved = await request(
      "POST",
      "/attachments",
      {
        conversationId,
        fileName: "never-uploaded.txt",
        mediaType: "text/plain",
        sizeBytes: 1,
        checksumSha256: "0".repeat(64),
      },
      owner.token,
    );
    expect(reserved.status).toBe(200);

    const queued = await request(
      "DELETE",
      `/attachments/${reserved.body.attachment.id}`,
      undefined,
      owner.token,
    );
    expect(queued.status).toBe(200);

    const headCallsBefore = store.headCalls;
    await deleteAttachmentObjects(reserved.body.attachment.id, store);
    expect(store.headCalls).toBe(headCallsBefore);
    const [remaining] = await db
      .select({ status: attachments.status })
      .from(attachments)
      .where(eq(attachments.id, reserved.body.attachment.id))
      .limit(1);
    expect(remaining?.status).toBe("deleted");
  });

  test("serializes concurrent draft quota reservations", async () => {
    const previousMaxPerMessage = process.env.ATTACHMENT_MAX_PER_MESSAGE;
    process.env.ATTACHMENT_MAX_PER_MESSAGE = "1";
    try {
      const owner = await register(`Quota ${crypto.randomUUID()}`);
      const { conversationId } = await workspaceWithMembers(owner);

      const results = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          request(
            "POST",
            "/attachments",
            {
              conversationId,
              fileName: `draft-${index}.txt`,
              mediaType: "text/plain",
              sizeBytes: 1,
              checksumSha256: "0".repeat(64),
            },
            owner.token,
          ),
        ),
      );
      expect(results.filter((result) => result.status === 200)).toHaveLength(2);
      expect(results.filter((result) => result.status === 429)).toHaveLength(10);

      const rows = await db
        .select({ id: attachments.id })
        .from(attachments)
        .where(eq(attachments.uploaderId, owner.user.id));
      expect(rows).toHaveLength(2);
    } finally {
      if (previousMaxPerMessage === undefined) {
        delete process.env.ATTACHMENT_MAX_PER_MESSAGE;
      } else {
        process.env.ATTACHMENT_MAX_PER_MESSAGE = previousMaxPerMessage;
      }
    }
  });
  test("serializes the per-user byte quota across conversations", async () => {
    const previous = {
      maxBytes: process.env.ATTACHMENT_MAX_BYTES,
      maxPerMessage: process.env.ATTACHMENT_MAX_PER_MESSAGE,
      draftQuotaBytes: process.env.ATTACHMENT_DRAFT_QUOTA_BYTES,
    };
    process.env.ATTACHMENT_MAX_BYTES = "10";
    process.env.ATTACHMENT_MAX_PER_MESSAGE = "10";
    process.env.ATTACHMENT_DRAFT_QUOTA_BYTES = "10";
    try {
      const owner = await register(`Global quota ${crypto.randomUUID()}`);
      const first = await workspaceWithMembers(owner);
      const second = await workspaceWithMembers(owner);
      const results = await Promise.all(
        [first.conversationId, second.conversationId].map(
          (conversationId, index) =>
            request(
              "POST",
              "/attachments",
              {
                conversationId,
                fileName: `global-draft-${index}.txt`,
                mediaType: "text/plain",
                sizeBytes: 6,
                checksumSha256: "1".repeat(64),
              },
              owner.token,
            ),
        ),
      );
      expect(results.map((result) => result.status).sort()).toEqual([200, 429]);

      const rows = await db
        .select({ id: attachments.id })
        .from(attachments)
        .where(eq(attachments.uploaderId, owner.user.id));
      expect(rows).toHaveLength(1);
    } finally {
      restoreEnv("ATTACHMENT_MAX_BYTES", previous.maxBytes);
      restoreEnv("ATTACHMENT_MAX_PER_MESSAGE", previous.maxPerMessage);
      restoreEnv("ATTACHMENT_DRAFT_QUOTA_BYTES", previous.draftQuotaBytes);
    }
  });
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

interface FakeStoredObject extends StoredObjectMetadata {
  bytes: Uint8Array;
}

class FakeObjectStore implements ObjectStore {
  headCalls = 0;
  headError: unknown = null;
  private readonly objects = new Map<string, FakeStoredObject>();
  private latestUpload: {
    key: string;
    mediaType: string;
    sizeBytes: number;
    checksumSha256Base64: string;
  } | null = null;
  private version = 0;

  async createUploadRequest(input: {
    key: string;
    mediaType: string;
    sizeBytes: number;
    checksumSha256Base64: string;
    expiresInSeconds: number;
  }): Promise<PresignedRequest> {
    this.latestUpload = input;
    return {
      method: "PUT",
      url: `https://upload.invalid/${encodeURIComponent(input.key)}`,
      headers: {
        "content-type": input.mediaType,
        "x-amz-checksum-sha256": input.checksumSha256Base64,
      },
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
    };
  }

  acceptLatestUpload(bytes: Uint8Array) {
    if (!this.latestUpload) throw new Error("No upload reservation");
    if (bytes.byteLength !== this.latestUpload.sizeBytes) {
      throw new Error("Test upload size mismatch");
    }
    this.objects.set(this.latestUpload.key, {
      bytes,
      versionId: `quarantine-${++this.version}`,
      sizeBytes: bytes.byteLength,
      checksumSha256Base64: this.latestUpload.checksumSha256Base64,
      contentType: this.latestUpload.mediaType,
    });
  }

  async headObject(input: { key: string; versionId?: string }) {
    this.headCalls += 1;
    if (this.headError) throw this.headError;
    const object = this.objects.get(input.key) ?? null;
    if (input.versionId && object?.versionId !== input.versionId) return null;
    return object;
  }

  async getObject(input: { key: string; versionId: string; maxBytes: number }) {
    const object = await this.headObject(input);
    if (!object) throw new Error("Object not found");
    if (object.bytes.byteLength > input.maxBytes) throw new Error("Object too large");
    return object.bytes;
  }

  async copyObject(input: {
    sourceKey: string;
    sourceVersionId: string;
    destinationKey: string;
    mediaType: string;
  }) {
    const source = await this.headObject({
      key: input.sourceKey,
      versionId: input.sourceVersionId,
    });
    if (!source) throw new Error("Source not found");
    const versionId = `clean-${++this.version}`;
    this.objects.set(input.destinationKey, {
      ...source,
      versionId,
      contentType: input.mediaType,
    });
    return { versionId };
  }

  async deleteObject(input: { key: string; versionId?: string | null }) {
    const current = this.objects.get(input.key);
    if (!input.versionId || current?.versionId === input.versionId) {
      this.objects.delete(input.key);
    }
  }

  async createDownloadRequest(input: {
    key: string;
    versionId: string;
    mediaType: string;
    contentDisposition: string;
    expiresInSeconds: number;
  }): Promise<PresignedRequest> {
    const object = await this.headObject({
      key: input.key,
      versionId: input.versionId,
    });
    if (!object) throw new Error("Clean object not found");
    return {
      method: "GET",
      url: `https://download.invalid/${encodeURIComponent(input.key)}?version=${encodeURIComponent(input.versionId)}`,
      headers: {},
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
    };
  }
}

function createFakeObjectStore() {
  return new FakeObjectStore();
}
