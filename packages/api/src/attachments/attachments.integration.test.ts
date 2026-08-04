import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import {
  context,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  type Context,
  type ContextManager,
} from "@opentelemetry/api";
import { Elysia } from "elysia";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { and, eq, inArray } from "drizzle-orm";
import { authRoutes } from "../auth";
import { botRoutes } from "../bots";
import { hermesPlatformRoutes } from "../hermes-platform";
import { conversationRoutes } from "../conversations";
import { db } from "../db";
import {
  attachments,
  eventOutbox,
  messageAttachments,
  messages,
  users,
  workspaces,
} from "../db/schema";
import { inviteRoutes } from "../invites";
import { messageRoutes } from "../messages";
import { setTracerForTests } from "../observability";
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
import { ATTACHMENT_VALIDATION_REQUESTED } from "./events";
import {
  reserveAttachment,
  setAttachmentObjectStoreForTests,
} from "./service";
import { removeMember } from "../services/workspaces";

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
const createdConversationIds: string[] = [];
const createdUserIds: string[] = [];
let store: ReturnType<typeof createFakeObjectStore>;
let testContextManager: AsyncLocalContextManager;

beforeAll(async () => {
  testContextManager = new AsyncLocalContextManager();
  context.disable();
  context.setGlobalContextManager(testContextManager.enable());
  store = createFakeObjectStore();
  setAttachmentObjectStoreForTests(store);
  await setRealtimeBusForTests(new LocalRealtimeBus());
});

afterAll(async () => {
  setAttachmentObjectStoreForTests(null);
  await closeRealtimeBusForTests();
  if (createdConversationIds.length > 0) {
    const createdAttachmentIds = await db
      .select({ id: attachments.id })
      .from(attachments)
      .where(inArray(attachments.conversationId, createdConversationIds));
    if (createdAttachmentIds.length > 0) {
      await db.delete(messageAttachments).where(
        inArray(
          messageAttachments.attachmentId,
          createdAttachmentIds.map(({ id }) => id),
        ),
      );
    }
  }
  if (createdWorkspaceIds.length > 0) {
    await db
      .delete(workspaces)
      .where(inArray(workspaces.id, createdWorkspaceIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  testContextManager.disable();
  context.disable();
});

async function request(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
  additionalHeaders: Record<string, string> = {},
) {
  const headers: Record<string, string> = { ...additionalHeaders };
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

async function captureSpans<T>(
  operation: () => Promise<T>,
): Promise<{ result: T; spans: ReadableSpan[] }> {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  setTracerForTests(provider.getTracer("attachment-integration-test"));
  try {
    const result = await operation();
    await provider.forceFlush();
    return { result, spans: exporter.getFinishedSpans() };
  } finally {
    setTracerForTests(null);
    await provider.shutdown();
  }
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

async function workspaceWithMembers(
  owner: Awaited<ReturnType<typeof register>>,
  member?: Awaited<ReturnType<typeof register>>,
) {
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
  createdConversationIds.push(detail.body.channels[0].id);
  return {
    workspaceId: created.body.id as string,
    conversationId: detail.body.channels[0].id as string,
  };
}

describe("attachment lifecycle", () => {
  test("removal-first serialization rejects stale attachment reservations", async () => {
    const owner = await register("Attachment race owner");
    const member = await register("Attachment race member");
    const { workspaceId, conversationId } = await workspaceWithMembers(
      owner,
      member,
    );

    let releaseRemoval!: () => void;
    const removalGate = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    let resolveRemovalLocked!: () => void;
    const removalLocked = new Promise<void>((resolve) => {
      resolveRemovalLocked = resolve;
    });
    const removing = removeMember(
      workspaceId,
      owner.user.id,
      member.user.id,
      {
        afterWorkspaceLocked: async () => {
          resolveRemovalLocked();
          await removalGate;
        },
      },
    );
    await removalLocked;

    let reservationAcquiredWorkspaceLock = false;
    const reservation = reserveAttachment(
      member.user.id,
      {
        conversationId,
        fileName: "stale.txt",
        mediaType: "text/plain",
        sizeBytes: 5,
        checksumSha256: crypto
          .createHash("sha256")
          .update("stale")
          .digest("hex"),
      },
      {
        store,
        afterWorkspaceLocked: async () => {
          reservationAcquiredWorkspaceLock = true;
        },
      },
    ).then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    await Bun.sleep(100);
    expect(reservationAcquiredWorkspaceLock).toBe(false);
    releaseRemoval();
    await removing;

    const outcome = await reservation;
    expect(reservationAcquiredWorkspaceLock).toBe(true);
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(outcome.error).toMatchObject({ status: 403 });
    }
    expect(
      await db
        .select({ id: attachments.id })
        .from(attachments)
        .where(eq(attachments.conversationId, conversationId)),
    ).toHaveLength(0);
  });

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

    const { result: replayedCompletion, spans: completionReplaySpans } =
      await captureSpans(() =>
        request(
          "POST",
          `/attachments/${attachmentId}/complete`,
          {},
          owner.token,
        ),
      );
    expect(
      completionReplaySpans.find((span) => span.name === "attachment.complete")
        ?.attributes["thechat.attachment.outcome"],
    ).toBe("already_processing");
    expect(replayedCompletion.status).toBe(200);
    expect(replayedCompletion.body.status).toBe("processing");
    const validationEvents = await db
      .select({ id: eventOutbox.id })
      .from(eventOutbox)
      .where(
        and(
          eq(eventOutbox.eventType, ATTACHMENT_VALIDATION_REQUESTED),
          eq(eventOutbox.aggregateId, attachmentId),
        ),
      );
    expect(validationEvents).toHaveLength(1);

    await validateAndPromoteAttachment(attachmentId, {
      store,
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
      request("POST", `/messages/${conversationId}`, sendPayload, owner.token),
      request("POST", `/messages/${conversationId}`, sendPayload, owner.token),
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

    const { result: contentRedirect, spans: contentRedirectSpans } =
      await captureSpans(() =>
        request(
          "GET",
          `/attachments/${attachmentId}/content`,
          undefined,
          owner.token,
        ),
      );
    expect(contentRedirect.status).toBe(302);
    const serverSpan = contentRedirectSpans.find(
      (span) => span.name === "HTTP GET /attachments/:id/content",
    );
    expect(serverSpan?.attributes["http.response.status_code"]).toBe(302);

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
    expect(
      history.body.find((message: any) => message.id === sent.body.id)
        ?.attachments,
    ).toEqual(sent.body.attachments);

    const { result: memberDownload, spans: memberDownloadSpans } =
      await captureSpans(() =>
        request(
          "GET",
          `/attachments/${attachmentId}/download`,
          undefined,
          member.token,
        ),
      );
    expect(memberDownload.status).toBe(200);
    expect(memberDownload.body.url).toContain("https://download.invalid/");
    const downloadServer = exactlyOneSpan(
      memberDownloadSpans,
      "HTTP GET /attachments/:id/download",
    );
    const authorizeDownload = exactlyOneSpan(
      memberDownloadSpans,
      "attachment.download.authorize",
    );
    expect(downloadServer.attributes["http.response.status_code"]).toBe(200);
    expect(authorizeDownload.parentSpanContext?.spanId).toBe(
      downloadServer.spanContext().spanId,
    );
    expect(authorizeDownload.attributes["thechat.attachment.outcome"]).toBe(
      "authorized",
    );
    expect(JSON.stringify(authorizeDownload.attributes)).not.toMatch(
      /download\.invalid|presigned|url/i,
    );

    const { result: strangerDownload, spans: strangerDownloadSpans } =
      await captureSpans(() =>
        request(
          "GET",
          `/attachments/${attachmentId}/download`,
          undefined,
          stranger.token,
        ),
      );
    expect(strangerDownload.status).toBe(403);
    const deniedServer = exactlyOneSpan(
      strangerDownloadSpans,
      "HTTP GET /attachments/:id/download",
    );
    const deniedAuthorization = exactlyOneSpan(
      strangerDownloadSpans,
      "attachment.download.authorize",
    );
    expect(deniedServer.attributes["http.response.status_code"]).toBe(403);
    expect(deniedServer.status.code).toBe(SpanStatusCode.UNSET);
    expect(deniedAuthorization.attributes["thechat.attachment.outcome"]).toBe(
      "rejected",
    );
    expect(
      deniedAuthorization.attributes["thechat.attachment.failure_reason"],
    ).toBe("forbidden");
    expect(deniedAuthorization.status.code).toBe(SpanStatusCode.ERROR);
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

  test("parents attachment server and service spans to the remote desktop carrier", async () => {
    const owner = await register("Traced attachment owner");
    const { conversationId } = await workspaceWithMembers(owner);
    const bytes = new TextEncoder().encode("trace attachment");
    const remoteTraceparent =
      "00-11111111111111111111111111111111-2222222222222222-01";

    const { result, spans } = await captureSpans(() =>
      request(
        "POST",
        "/attachments",
        {
          conversationId,
          fileName: "traced.txt",
          mediaType: "text/plain",
          sizeBytes: bytes.byteLength,
          checksumSha256: crypto
            .createHash("sha256")
            .update(bytes)
            .digest("hex"),
        },
        owner.token,
        { traceparent: remoteTraceparent },
      ),
    );
    expect(result.status).toBe(200);
    const server = exactlyOneSpan(spans, "HTTP POST /attachments");
    const reserve = exactlyOneSpan(spans, "attachment.reserve");
    expect(server.kind).toBe(SpanKind.SERVER);
    expect(server.spanContext().traceId).toBe(
      "11111111111111111111111111111111",
    );
    expect(server.parentSpanContext?.spanId).toBe("2222222222222222");
    expect(server.attributes["http.response.status_code"]).toBe(200);
    expect(reserve.spanContext().traceId).toBe(server.spanContext().traceId);
    expect(reserve.parentSpanContext?.spanId).toBe(
      server.spanContext().spanId,
    );
    expect(reserve.attributes["thechat.attachment.outcome"]).toBe("reserved");
    expect(
      JSON.stringify(
        spans.map((span) => ({
          name: span.name,
          attributes: span.attributes,
          events: span.events,
          status: span.status,
        })),
      ),
    ).not.toMatch(
      /traced\.txt|checksum|authorization|presigned|upload\.invalid/i,
    );

    const unauthorized = await captureSpans(() =>
      request("POST", "/attachments", {}, undefined, {
        traceparent: remoteTraceparent,
      }),
    );
    expect(unauthorized.result.status).toBe(401);
    expect(
      exactlyOneSpan(unauthorized.spans, "HTTP POST /attachments").attributes[
        "http.response.status_code"
      ],
    ).toBe(401);

    const originalCreateUploadRequest = store.createUploadRequest.bind(store);
    store.createUploadRequest = async () => {
      throw new Error(
        "postgres://secret:password@db.invalid/thechat?token=never-export",
      );
    };
    try {
      const failed = await captureSpans(() =>
        request(
          "POST",
          "/attachments",
          {
            conversationId,
            fileName: "failed.txt",
            mediaType: "text/plain",
            sizeBytes: bytes.byteLength,
            checksumSha256: "a".repeat(64),
          },
          owner.token,
          { traceparent: remoteTraceparent },
        ),
      );
      expect(failed.result.status).toBe(500);
      expect(failed.result.body).toEqual({ error: "Internal server error" });
      const failedServer = exactlyOneSpan(
        failed.spans,
        "HTTP POST /attachments",
      );
      const failedReserve = exactlyOneSpan(
        failed.spans,
        "attachment.reserve",
      );
      expect(failedServer.attributes["http.response.status_code"]).toBe(500);
      expect(failedServer.status.code).toBe(SpanStatusCode.ERROR);
      expect(failedServer.events).toHaveLength(0);
      expect(failedReserve.status.code).toBe(SpanStatusCode.ERROR);
      expect(failedReserve.events).toHaveLength(1);
      expect(
        JSON.stringify(
          failed.spans.map((span) => ({
            name: span.name,
            attributes: span.attributes,
            events: span.events,
            status: span.status,
          })),
        ),
      ).not.toMatch(/secret|password|never-export/i);
    } finally {
      store.createUploadRequest = originalCreateUploadRequest;
    }
  });

  test("keeps attachment binding and outbox production under the remote message trace", async () => {
    const owner = await register("Traced message owner");
    const { conversationId } = await workspaceWithMembers(owner);
    const bytes = new TextEncoder().encode("message attachment");
    const checksum = crypto.createHash("sha256").update(bytes).digest("hex");
    const reserved = await request(
      "POST",
      "/attachments",
      {
        conversationId,
        fileName: "message-trace.txt",
        mediaType: "text/plain",
        sizeBytes: bytes.byteLength,
        checksumSha256: checksum,
      },
      owner.token,
    );
    expect(reserved.status).toBe(200);
    const attachmentId = reserved.body.attachment.id as string;
    store.acceptLatestUpload(bytes);
    expect(
      (
        await request(
          "POST",
          `/attachments/${attachmentId}/complete`,
          {},
          owner.token,
        )
      ).status,
    ).toBe(200);
    await validateAndPromoteAttachment(attachmentId, {
      store,
      maxBytes: 25 * 1024 * 1024,
    });

    const remoteTraceparent =
      "00-33333333333333333333333333333333-4444444444444444-01";
    const clientMessageId = crypto.randomUUID();
    const traced = await captureSpans(() =>
      request(
        "POST",
        `/messages/${conversationId}`,
        { content: "", attachmentIds: [attachmentId], clientMessageId },
        owner.token,
        { traceparent: remoteTraceparent },
      ),
    );
    expect(traced.result.status).toBe(200);
    const server = exactlyOneSpan(
      traced.spans,
      "HTTP POST /messages/:conversationId",
    );
    const send = exactlyOneSpan(traced.spans, "message.send");
    const bind = exactlyOneSpan(traced.spans, "attachment.bind");
    const produce = exactlyOneSpan(
      traced.spans,
      "domain_event.outbox.enqueue",
    );
    expect(server.kind).toBe(SpanKind.SERVER);
    expect(server.spanContext().traceId).toBe(
      "33333333333333333333333333333333",
    );
    expect(server.parentSpanContext?.spanId).toBe("4444444444444444");
    expect(server.attributes["http.response.status_code"]).toBe(200);
    expect(send.parentSpanContext?.spanId).toBe(server.spanContext().spanId);
    expect(send.attributes["thechat.message.outcome"]).toBe("sent");
    expect(send.attributes["thechat.outbox.outcome"]).toBe("committed");
    expect(send.attributes["thechat.attachment.binding_outcome"]).toBe(
      "committed",
    );
    expect(bind.parentSpanContext?.spanId).toBe(send.spanContext().spanId);
    expect(bind.attributes["thechat.attachment.binding_outcome"]).toBe(
      "staged",
    );
    expect(produce.kind).toBe(SpanKind.PRODUCER);
    expect(produce.attributes["thechat.outbox.outcome"]).toBe("staged");
    expect(produce.parentSpanContext?.spanId).toBe(send.spanContext().spanId);

    const conflict = await captureSpans(() =>
      request(
        "POST",
        `/messages/${conversationId}`,
        {
          content: "changed",
          attachmentIds: [attachmentId],
          clientMessageId,
        },
        owner.token,
        { traceparent: remoteTraceparent },
      ),
    );
    expect(conflict.result.status).toBe(409);
    const conflictServer = exactlyOneSpan(
      conflict.spans,
      "HTTP POST /messages/:conversationId",
    );
    const conflictSend = exactlyOneSpan(conflict.spans, "message.send");
    expect(conflictServer.attributes["http.response.status_code"]).toBe(409);
    expect(conflictServer.status.code).toBe(SpanStatusCode.UNSET);
    expect(conflictSend.attributes["thechat.message.outcome"]).toBe(
      "idempotency_conflict",
    );
    expect(conflictSend.status.code).toBe(SpanStatusCode.ERROR);
  });

  test("rejects active content during validation without promoting it", async () => {
    const owner = await register("Unsafe attachment owner");
    const { conversationId } = await workspaceWithMembers(owner);
    const bytes = new TextEncoder().encode(
      "<!doctype html><script>alert('attachment')</script>",
    );
    const checksum = crypto.createHash("sha256").update(bytes).digest("hex");

    const reserved = await request(
      "POST",
      "/attachments",
      {
        conversationId,
        fileName: "active-content.txt",
        mediaType: "text/plain",
        sizeBytes: bytes.byteLength,
        checksumSha256: checksum,
      },
      owner.token,
    );
    expect(reserved.status).toBe(200);
    store.acceptLatestUpload(bytes);
    const attachmentId = reserved.body.attachment.id as string;

    const completed = await request(
      "POST",
      `/attachments/${attachmentId}/complete`,
      {},
      owner.token,
    );
    expect(completed.status).toBe(200);
    expect(completed.body.status).toBe("processing");

    const [storedBeforeRejection] = await db
      .select({
        quarantineKey: attachments.quarantineKey,
        quarantineVersionId: attachments.quarantineVersionId,
      })
      .from(attachments)
      .where(eq(attachments.id, attachmentId))
      .limit(1);
    expect(storedBeforeRejection?.quarantineVersionId).toBeTruthy();

    await validateAndPromoteAttachment(attachmentId, {
      store,
      maxBytes: 25 * 1024 * 1024,
    });

    const rejected = await request(
      "GET",
      `/attachments/${attachmentId}`,
      undefined,
      owner.token,
    );
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe("rejected");
    const [row] = await db
      .select({
        failureReason: attachments.failureReason,
        quarantineVersionId: attachments.quarantineVersionId,
        cleanVersionId: attachments.cleanVersionId,
        deletedAt: attachments.deletedAt,
      })
      .from(attachments)
      .where(eq(attachments.id, attachmentId))
      .limit(1);
    expect(row?.failureReason).toBe("active_content");
    expect(row?.quarantineVersionId).toBeNull();
    expect(row?.cleanVersionId).toBeNull();
    expect(row?.deletedAt).toBeInstanceOf(Date);
    expect(
      await store.headObject({
        key: storedBeforeRejection!.quarantineKey,
        versionId: storedBeforeRejection!.quarantineVersionId!,
      }),
    ).toBeNull();
  });

  test("bots get attachment access and shared limits by default, while owners can still disable access", async () => {
    const owner = await register("Bot attachment owner");
    const { workspaceId, conversationId } = await workspaceWithMembers(owner);
    const created = await request(
      "POST",
      "/bots/create",
      {
        name: "Hermes attachments by default",
        kind: "hermes",
        workspaceId,
      },
      owner.token,
    );
    expect(created.status).toBe(200);
    expect(created.body.attachmentAccess).toBe(true);
    createdUserIds.push(created.body.userId);
    const botToken = created.body.apiKey as string;
    const checksum = crypto.createHash("sha256").update("x").digest("hex");

    const aboveOldBotLimit = await request(
      "POST",
      "/attachments",
      {
        conversationId,
        fileName: "shared-limit.txt",
        mediaType: "text/plain",
        sizeBytes: 10 * 1024 * 1024 + 1,
        checksumSha256: checksum,
      },
      botToken,
    );
    expect(aboveOldBotLimit.status).toBe(200);

    const { result: aboveSharedLimit, spans: oversizedSpans } =
      await captureSpans(() =>
        request(
          "POST",
          "/attachments",
          {
            conversationId,
            fileName: "oversized.txt",
            mediaType: "text/plain",
            sizeBytes: 25 * 1024 * 1024 + 1,
            checksumSha256: checksum,
          },
          botToken,
        ),
      );
    expect(aboveSharedLimit.status).toBe(400);
    const oversizedServer = exactlyOneSpan(
      oversizedSpans,
      "HTTP POST /attachments",
    );
    const oversizedReservation = exactlyOneSpan(
      oversizedSpans,
      "attachment.reserve",
    );
    expect(oversizedServer.attributes["http.response.status_code"]).toBe(400);
    expect(oversizedServer.status.code).toBe(SpanStatusCode.UNSET);
    expect(oversizedReservation.attributes["thechat.attachment.outcome"]).toBe(
      "rejected",
    );
    expect(
      oversizedReservation.attributes["thechat.attachment.failure_reason"],
    ).toBe("invalid_request");
    expect(oversizedReservation.status.code).toBe(SpanStatusCode.ERROR);

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
      maxBytes: 25 * 1024 * 1024,
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
      const { result: completed, spans: completionSpans } = await captureSpans(
        () =>
          request(
            "POST",
            `/attachments/${reserved.body.attachment.id}/complete`,
            undefined,
            owner.token,
          ),
      );
      expect(completed.status).toBe(409);
      expect(completed.body.error).toBe("Uploaded object was not found");
      const completionServer = exactlyOneSpan(
        completionSpans,
        "HTTP POST /attachments/:id/complete",
      );
      const completionOperation = exactlyOneSpan(
        completionSpans,
        "attachment.complete",
      );
      expect(completionServer.attributes["http.response.status_code"]).toBe(409);
      expect(completionServer.status.code).toBe(SpanStatusCode.UNSET);
      expect(completionOperation.attributes["thechat.attachment.outcome"]).toBe(
        "rejected",
      );
      expect(
        completionOperation.attributes["thechat.attachment.failure_reason"],
      ).toBe("lifecycle_conflict");
      expect(completionOperation.status.code).toBe(SpanStatusCode.ERROR);
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
    const { spans: deletionSpans } = await captureSpans(() =>
      deleteAttachmentObjects(reserved.body.attachment.id, store),
    );
    const deletionSpan = exactlyOneSpan(
      deletionSpans,
      "attachment.delete_objects",
    );
    expect(deletionSpan.attributes["thechat.attachment.outcome"]).toBe(
      "deleted",
    );
    expect(deletionSpan.attributes["thechat.attachment.next_status"]).toBe(
      "deleted",
    );
    expect(deletionSpan.status.code).toBe(SpanStatusCode.UNSET);
    expect(store.headCalls).toBe(headCallsBefore);
    const [remaining] = await db
      .select({ status: attachments.status })
      .from(attachments)
      .where(eq(attachments.id, reserved.body.attachment.id))
      .limit(1);
    expect(remaining?.status).toBe("deleted");
  });

  test("keeps deletion nonterminal after a partial object-store failure and retries both exact versions", async () => {
    const owner = await register(`Partial delete ${crypto.randomUUID()}`);
    const { conversationId } = await workspaceWithMembers(owner);
    const bytes = new TextEncoder().encode("partial deletion fixture");
    const checksum = crypto.createHash("sha256").update(bytes).digest("hex");
    const reserved = await request(
      "POST",
      "/attachments",
      {
        conversationId,
        fileName: "partial-delete.txt",
        mediaType: "text/plain",
        sizeBytes: bytes.byteLength,
        checksumSha256: checksum,
      },
      owner.token,
    );
    expect(reserved.status).toBe(200);
    const attachmentId = reserved.body.attachment.id as string;
    store.acceptLatestUpload(bytes);
    expect(
      (
        await request(
          "POST",
          `/attachments/${attachmentId}/complete`,
          undefined,
          owner.token,
        )
      ).status,
    ).toBe(200);
    await validateAndPromoteAttachment(attachmentId, {
      store,
      maxBytes: 25 * 1024 * 1024,
    });

    const [coordinates] = await db
      .select({
        quarantineKey: attachments.quarantineKey,
        quarantineVersionId: attachments.quarantineVersionId,
        cleanKey: attachments.cleanKey,
        cleanVersionId: attachments.cleanVersionId,
      })
      .from(attachments)
      .where(eq(attachments.id, attachmentId))
      .limit(1);
    expect(coordinates?.quarantineVersionId).toBeTruthy();
    expect(coordinates?.cleanVersionId).toBeTruthy();
    expect(
      (
        await request(
          "DELETE",
          `/attachments/${attachmentId}`,
          undefined,
          owner.token,
        )
      ).status,
    ).toBe(200);

    store.deleteErrorKey = coordinates!.quarantineKey;
    await expect(deleteAttachmentObjects(attachmentId, store)).rejects.toThrow(
      "simulated attachment object delete failure",
    );
    const [partial] = await db
      .select({
        status: attachments.status,
        deletedAt: attachments.deletedAt,
        quarantineVersionId: attachments.quarantineVersionId,
        cleanVersionId: attachments.cleanVersionId,
      })
      .from(attachments)
      .where(eq(attachments.id, attachmentId))
      .limit(1);
    expect(partial).toMatchObject({
      status: "deleting",
      deletedAt: null,
      quarantineVersionId: coordinates!.quarantineVersionId,
      cleanVersionId: coordinates!.cleanVersionId,
    });
    expect(
      await store.headObject({
        key: coordinates!.cleanKey!,
        versionId: coordinates!.cleanVersionId!,
      }),
    ).toBeNull();
    expect(
      await store.headObject({
        key: coordinates!.quarantineKey,
        versionId: coordinates!.quarantineVersionId!,
      }),
    ).not.toBeNull();

    store.deleteErrorKey = null;
    await deleteAttachmentObjects(attachmentId, store);
    const [deleted] = await db
      .select({
        status: attachments.status,
        deletedAt: attachments.deletedAt,
        quarantineVersionId: attachments.quarantineVersionId,
        cleanVersionId: attachments.cleanVersionId,
      })
      .from(attachments)
      .where(eq(attachments.id, attachmentId))
      .limit(1);
    expect(deleted?.status).toBe("deleted");
    expect(deleted?.deletedAt).toBeInstanceOf(Date);
    expect(deleted?.quarantineVersionId).toBeNull();
    expect(deleted?.cleanVersionId).toBeNull();
    expect(
      await store.headObject({
        key: coordinates!.quarantineKey,
        versionId: coordinates!.quarantineVersionId!,
      }),
    ).toBeNull();
    expect(
      await store.headObject({
        key: coordinates!.cleanKey!,
        versionId: coordinates!.cleanVersionId!,
      }),
    ).toBeNull();
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
      expect(results.filter((result) => result.status === 429)).toHaveLength(
        10,
      );

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

function exactlyOneSpan(spans: ReadableSpan[], name: string) {
  const matches = spans.filter((span) => span.name === name);
  expect(matches, `expected exactly one ${name} span`).toHaveLength(1);
  return matches[0]!;
}

class AsyncLocalContextManager implements ContextManager {
  private readonly storage = new AsyncLocalStorage<Context>();

  active() {
    return this.storage.getStore() ?? ROOT_CONTEXT;
  }

  with<T extends (...args: any[]) => any>(
    activeContext: Context,
    fn: T,
    thisArg?: ThisParameterType<T>,
    ...args: Parameters<T>
  ): ReturnType<T> {
    return this.storage.run(activeContext, () => fn.call(thisArg, ...args));
  }

  bind<T>(activeContext: Context, target: T): T {
    if (typeof target !== "function") return target;
    const manager = this;
    return function (this: unknown, ...args: unknown[]) {
      return manager.with(activeContext, target as (...values: unknown[]) => unknown, this, ...args);
    } as T;
  }

  enable() {
    return this;
  }

  disable() {
    this.storage.disable();
    return this;
  }
}

interface FakeStoredObject extends StoredObjectMetadata {
  bytes: Uint8Array;
}

class FakeObjectStore implements ObjectStore {
  headCalls = 0;
  headError: unknown = null;
  deleteErrorKey: string | null = null;
  readonly deleteCalls: Array<{ key: string; versionId?: string | null }> = [];
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
    if (object.bytes.byteLength > input.maxBytes)
      throw new Error("Object too large");
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
    this.deleteCalls.push(input);
    if (input.key === this.deleteErrorKey) {
      throw new Error("simulated attachment object delete failure");
    }
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
