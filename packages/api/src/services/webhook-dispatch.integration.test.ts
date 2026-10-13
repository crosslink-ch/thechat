import { afterEach, expect, test, spyOn } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  users,
  workspaces,
  bots,
  conversations,
  messages,
  botInvocations,
  attachments,
  messageAttachments,
} from "../db/schema";
import { createWorkspace } from "./workspaces";
import { addOwnedBotToWorkspace } from "./bot-workspace-memberships";
import { removeBotFromWorkspace, updateAuthenticatedBotWebhook } from "./bots";
import {
  __botRuntimeInternalsForTests as internals,
  publishHermesPlatformProgress,
  submitHermesPlatformInteraction,
} from "./bot-runtime";

test("human interaction relay rechecks installation immediately before its outbound fetch", async () => {
  let calls = 0;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls++;
      return Response.json({ ok: true });
    },
  });
  const f = await fixture("hermes");
  await db
    .update(botInvocations)
    .set({ status: "claimed" })
    .where(eq(botInvocations.id, f.invocation.id));
  const progress = await publishHermesPlatformProgress({
    authenticatedBotId: f.bot.id,
    invocationId: f.invocation.id,
    type: "approval.request",
    status: "waiting",
    payload: {
      requestId: "synthetic-approval",
      sessionKey: "synthetic-session",
      command: "true",
      description: "Synthetic operation",
      choices: ["once", "deny"],
    },
  });
  const error = await (submitHermesPlatformInteraction as any)(
    {
      userId: f.owner.id,
      userType: "human",
      invocationId: f.invocation.id,
      eventId: progress.event!.id,
      response: "once",
    },
    {
      beforeDispatch: async () => {
        await updateBotInstallation(f.workspace.id, f.bot.id, f.owner.id, {
          enabled: false,
          channelScope: "all",
          conversationIds: [],
          attachmentAccess: false,
          sharedRuntimeConsent: true,
          expectedRevision: 1,
        });
      },
    },
  ).then(
    () => null,
    (e: any) => e,
  );
  expect(calls).toBe(0);
  expect(error?.status).toBe(409);
});
import { updateBotInstallation } from "./bot-installation-access";
import { claimHermesPlatformEvents } from "./bot-runtime";

test("polling claim intersects captured attachment metadata with current global safety", async () => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ ok: true }),
  });
  const f = await fixture("hermes");
  await db
    .update(bots)
    .set({ attachmentAccess: true })
    .where(eq(bots.id, f.bot.id));
  await updateBotInstallation(f.workspace.id, f.bot.id, f.owner.id, {
    enabled: true,
    channelScope: "all",
    conversationIds: [],
    attachmentAccess: true,
    sharedRuntimeConsent: true,
    expectedRevision: 1,
  });
  const [file] = await db
    .insert(attachments)
    .values({
      conversationId: f.channel.id,
      uploaderId: f.owner.id,
      fileName: "synthetic.txt",
      declaredMediaType: "text/plain",
      verifiedMediaType: "text/plain",
      declaredSizeBytes: 1,
      declaredChecksumSha256: "a".repeat(64),
      verifiedSizeBytes: 1,
      status: "attached",
      quarantineKey: "synthetic/pending",
      cleanKey: "synthetic/clean",
      cleanVersionId: "synthetic-v1",
      uploadExpiresAt: new Date(),
      expiresAt: new Date(),
    })
    .returning();
  await db
    .insert(messageAttachments)
    .values({ messageId: f.message.id, attachmentId: file.id, position: 0 });
  const transaction = db.transaction.bind(db);
  let armed = true;
  const pause = spyOn(db, "transaction").mockImplementation((async (
    operation: any,
  ) => {
    if (armed) {
      armed = false;
      await db
        .update(bots)
        .set({ attachmentAccess: false })
        .where(eq(bots.id, f.bot.id));
    }
    return transaction(operation);
  }) as any);
  try {
    const events = await claimHermesPlatformEvents(f.bot.id, 1);
    expect(events).toHaveLength(1);
    expect(events[0].attachments).toHaveLength(0);
    const [claimed] = await db
      .select()
      .from(botInvocations)
      .where(eq(botInvocations.id, f.invocation.id));
    expect(claimed.requestJson?.attachments).toEqual([]);
  } finally {
    pause.mockRestore();
  }
});

test("polling claim denies a grant revision revoked after payload capture", async () => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ ok: true }),
  });
  const f = await fixture("hermes");
  const transaction = db.transaction.bind(db);
  let armed = true;
  const pause = spyOn(db, "transaction").mockImplementation((async (
    operation: any,
  ) => {
    if (armed) {
      armed = false;
      await updateBotInstallation(f.workspace.id, f.bot.id, f.owner.id, {
        enabled: true,
        channelScope: "all",
        conversationIds: [],
        attachmentAccess: false,
        sharedRuntimeConsent: true,
        expectedRevision: 1,
      });
    }
    return transaction(operation);
  }) as any);
  try {
    const events = await claimHermesPlatformEvents(f.bot.id, 1);
    expect(armed).toBe(false);
    expect(events).toHaveLength(0);
  } finally {
    pause.mockRestore();
  }
});

test("endpoint revision changing after capture cannot dispatch or retry without workspace approval", async () => {
  let calls = 0;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls++;
      return new Response("ok");
    },
  });
  const f = await fixture("hermes");
  await internals.deliverHermesPlatformWebhookInvocation(f.invocation.id, {
    beforeDispatch: async () => {
      await updateAuthenticatedBotWebhook(
        f.botUser.id,
        `http://127.0.0.1:${server!.port}/changed`,
      );
    },
  });
  await internals.deliverHermesPlatformWebhookInvocation(f.invocation.id);
  expect(calls).toBe(0);
});

test("Hermes grant revision changing after claim fences the captured body and its retry", async () => {
  let calls = 0;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls++;
      return new Response("ok");
    },
  });
  const f = await fixture("hermes");
  await internals.deliverHermesPlatformWebhookInvocation(f.invocation.id, {
    beforeDispatch: async () => {
      await updateBotInstallation(f.workspace.id, f.bot.id, f.owner.id, {
        enabled: true,
        channelScope: "all",
        conversationIds: [],
        attachmentAccess: false,
        sharedRuntimeConsent: true,
        expectedRevision: 1,
      });
    },
  });
  await internals.deliverHermesPlatformWebhookInvocation(f.invocation.id);
  expect(calls).toBe(0);
});

import crypto from "node:crypto";
import { submitHermesPlatformVaultUnlock } from "./bot-runtime";

test("vault relay cannot use a grant revoked after encrypted context capture", async () => {
  let calls = 0;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls++;
      return Response.json({ ok: true, duplicate: false });
    },
  });
  const f = await fixture("hermes");
  await db
    .update(botInvocations)
    .set({ status: "claimed" })
    .where(eq(botInvocations.id, f.invocation.id));
  const key = crypto.generateKeyPairSync("rsa", {
    modulusLength: 3072,
  }).publicKey;
  const event = await publishHermesPlatformProgress({
    authenticatedBotId: f.bot.id,
    invocationId: f.invocation.id,
    type: "vault.unlock.request",
    payload: {
      version: 2,
      requestId: crypto.randomUUID(),
      sessionKey: "synthetic-vault-session",
      profileId: "synthetic-profile",
      backend: "bitwarden",
      requesterUserId: f.owner.id,
      nonce: crypto.randomBytes(32).toString("base64url"),
      expiresAt: Date.now() + 120000,
      algorithm: "RSA-OAEP-3072-SHA256+A256GCM",
      publicKeySpkiB64: key
        .export({ format: "der", type: "spki" })
        .toString("base64"),
    },
  });
  const error = await (submitHermesPlatformVaultUnlock as any)(
    {
      userId: f.owner.id,
      userType: "human",
      invocationId: f.invocation.id,
      eventId: event.event!.id,
      response: { version: 2, action: "cancel" },
    },
    {
      beforeDispatch: async () => {
        await updateBotInstallation(f.workspace.id, f.bot.id, f.owner.id, {
          enabled: false,
          channelScope: "all",
          conversationIds: [],
          attachmentAccess: false,
          sharedRuntimeConsent: true,
          expectedRevision: 1,
        });
      },
    },
  ).then(
    () => null,
    (e: any) => e,
  );
  expect(calls).toBe(0);
  expect(error?.status).toBe(409);
});

const ids: string[] = [],
  wids: string[] = [];
let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(async () => {
  server?.stop(true);
  server = undefined;
  if (wids.length)
    await db.delete(workspaces).where(inArray(workspaces.id, wids.splice(0)));
  if (ids.length)
    await db.delete(users).where(inArray(users.id, ids.splice(0)));
});
async function fixture(kind: "webhook" | "hermes") {
  const [owner, botUser] = await db
    .insert(users)
    .values([{ name: "Dispatch owner" }, { name: "Dispatch bot", type: "bot" }])
    .returning();
  ids.push(owner.id, botUser.id);
  const workspace = await createWorkspace("Dispatch synthetic", owner.id);
  wids.push(workspace.id);
  const [bot] = await db
    .insert(bots)
    .values({
      userId: botUser.id,
      ownerId: owner.id,
      kind,
      webhookUrl: `http://127.0.0.1:${server!.port}/hook`,
      webhookSecret: "synthetic-secret",
    })
    .returning();
  await addOwnedBotToWorkspace(bot.id, workspace.id, owner.id);
  const [channel] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.workspaceId, workspace.id));
  const [message] = await db
    .insert(messages)
    .values({
      senderId: owner.id,
      conversationId: channel.id,
      content: "synthetic trigger",
    })
    .returning();
  const [invocation] = await db
    .insert(botInvocations)
    .values({
      botId: bot.id,
      conversationId: channel.id,
      triggerMessageId: message.id,
      adapterKind: kind,
      status: "queued",
      requestJson: {},
    })
    .returning();
  return { owner, botUser, bot, workspace, channel, message, invocation };
}

test("webhook cancellation between worker capture and dispatch produces zero external calls", async () => {
  let calls = 0;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls++;
      return new Response("ok");
    },
  });
  const f = await fixture("webhook");
  expect(typeof (internals as any).handleQueuedBotInvocation).toBe("function");
  await (internals as any).handleQueuedBotInvocation(f.invocation.id, {
    async setProgress(progress: number) {
      if (progress === 15)
        await db
          .update(botInvocations)
          .set({ status: "cancelled" })
          .where(eq(botInvocations.id, f.invocation.id));
    },
  });
  expect(calls).toBe(0);
});

test("webhook refuses redirects instead of forwarding tenant payload", async () => {
  let redirected = 0;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/hook")
        return new Response(null, {
          status: 307,
          headers: { location: "/exfiltrate" },
        });
      redirected++;
      return new Response("ok");
    },
  });
  const f = await fixture("webhook");
  const error = await internals
    .handleQueuedBotInvocation(f.invocation.id, { async setProgress() {} })
    .then(
      () => null,
      (e) => e,
    );
  expect(redirected).toBe(0);
  expect(error).not.toBeNull();
});

test("outbound webhook request is aborted within configured bounded timeout", async () => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      await Bun.sleep(800);
      return new Response("late");
    },
  });
  const f = await fixture("webhook");
  const previous = process.env.BOT_WEBHOOK_TIMEOUT_MS;
  process.env.BOT_WEBHOOK_TIMEOUT_MS = "50";
  // Measure the HTTP deadline itself, not DB/claim latency preceding dispatch.
  // The real loopback fetch is preserved; its actual AbortSignal is asserted.
  const realFetch = globalThis.fetch;
  let elapsed = Number.POSITIVE_INFINITY;
  let signal: AbortSignal | undefined;
  let calls = 0;
  const observed = spyOn(globalThis, "fetch").mockImplementation((async (url: any, options: any) => {
    calls++;
    signal = options.signal;
    const started = Date.now();
    try { return await realFetch(url, options); }
    finally { elapsed = Date.now() - started; }
  }) as any);
  try {
    const error = await internals
      .handleQueuedBotInvocation(f.invocation.id, { async setProgress() {} })
      .then(
        () => null,
        (e) => e,
      );
    expect(error).not.toBeNull();
    expect(calls).toBe(1);
    expect(signal?.aborted).toBe(true);
    expect(elapsed).toBeLessThan(650);
  } finally {
    observed.mockRestore();
    if (previous === undefined) delete process.env.BOT_WEBHOOK_TIMEOUT_MS;
    else process.env.BOT_WEBHOOK_TIMEOUT_MS = previous;
  }
});

test("Hermes removal immediately before outbound fetch produces zero calls, including retry", async () => {
  let calls = 0;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls++;
      return new Response("ok");
    },
  });
  const f = await fixture("hermes");
  expect(typeof (internals as any).deliverHermesPlatformWebhookInvocation).toBe(
    "function",
  );
  await (internals as any).deliverHermesPlatformWebhookInvocation(
    f.invocation.id,
    {
      beforeDispatch: async () => {
        await removeBotFromWorkspace(f.bot.id, f.workspace.id, f.owner.id);
      },
    },
  );
  await (internals as any).deliverHermesPlatformWebhookInvocation(
    f.invocation.id,
  );
  expect(calls).toBe(0);
});
