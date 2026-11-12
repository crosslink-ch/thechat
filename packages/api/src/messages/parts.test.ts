import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { Elysia } from "elysia";
import { db } from "../db";
import { queueJobs as eventOutbox } from "../async/job-schema";
import {
  botInvocations,
  conversationParticipants,
  messages,
  messageThreadFollowers,
  users,
  workspaceMembers,
  workspaces,
} from "../db/schema";
import { authRoutes } from "../auth";
import { workspaceRoutes } from "../workspaces";
import { conversationRoutes } from "../conversations";
import { botRoutes } from "../bots";
import { hermesPlatformRoutes } from "../hermes-platform";
import { mcpRoutes } from "../mcp";
import { wsRoutes } from "../ws";
import { closeDomainEventRuntime, startDomainEventRuntime } from "../events/runtime";
import { closeBotRuntimeForTests, startBotWorker } from "../services/bot-runtime";
import {
  closeBotProgressStoreForTests,
  createLocalBotProgressStoreForTests,
  setBotProgressStoreForTests,
} from "../services/bot-progress-store";
import { hermesPromptFromParts } from "../services/hermes";
import { messageRoutes } from "./index";

/**
 * Mentions by user ID ("parts-v1") through every write path: REST, WebSocket,
 * the Hermes platform and MCP. The visible "@Name" is only a label: routing,
 * notifications and thread following come from the referenced IDs.
 */

const app = new Elysia()
  .use(authRoutes)
  .use(workspaceRoutes)
  .use(conversationRoutes)
  .use(messageRoutes)
  .use(botRoutes)
  .use(hermesPlatformRoutes)
  .use(mcpRoutes)
  .use(wsRoutes)
  .listen(0);
const baseUrl = `http://127.0.0.1:${app.server!.port}`;

const createdEmails: string[] = [];
const createdWorkspaceIds: string[] = [];
const createdBotUserIds: string[] = [];
const keyPrefix = process.env.REDIS_KEY_PREFIX;

beforeAll(async () => {
  process.env.REDIS_KEY_PREFIX = `thechat-parts-test-${crypto.randomUUID()}`;
  await setBotProgressStoreForTests(createLocalBotProgressStoreForTests());
  await startDomainEventRuntime();
  await startBotWorker({ concurrency: 1 });
});

afterAll(async () => {
  await closeDomainEventRuntime();
  await closeBotRuntimeForTests();
  await closeBotProgressStoreForTests();
  app.stop();
  if (keyPrefix === undefined) delete process.env.REDIS_KEY_PREFIX;
  else process.env.REDIS_KEY_PREFIX = keyPrefix;
  const humans = createdEmails.length
    ? await db.select({ id: users.id }).from(users).where(inArray(users.email, createdEmails))
    : [];
  const actors = [...createdBotUserIds, ...humans.map((user) => user.id)];
  if (actors.length) await db.delete(eventOutbox).where(inArray(eventOutbox.actorId, actors));
  if (createdWorkspaceIds.length) {
    await db.delete(eventOutbox).where(inArray(eventOutbox.tenantId, createdWorkspaceIds));
  }
  for (const id of createdBotUserIds) await db.delete(users).where(eq(users.id, id));
  for (const id of createdWorkspaceIds) await db.delete(workspaces).where(eq(workspaces.id, id));
  for (const human of humans) await db.delete(users).where(eq(users.id, human.id));
});

// -- Helpers ------------------------------------------------------------------

async function req(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Keep the raw text for assertion messages.
  }
  return { status: response.status, body: parsed };
}

async function ok(method: string, path: string, body?: unknown, token?: string) {
  const res = await req(method, path, body, token);
  expect(res.status, `${method} ${path}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body;
}

type Person = { token: string; id: string; name: string; email: string };

async function register(name: string): Promise<Person> {
  const email = `parts-${crypto.randomUUID()}@test.com`;
  createdEmails.push(email);
  const body = await ok("POST", "/auth/register", { name, email, password: "password123" });
  return { token: body.accessToken, id: body.user.id, name, email };
}

/** Owner and a member in a workspace with its #general channel. */
async function workspace(label: string) {
  const owner = await register(`${label} Owner`);
  const member = await register(`${label} Member`);
  const ws = await ok("POST", "/workspaces/create", { name: `Parts ${label}` }, owner.token);
  createdWorkspaceIds.push(ws.id);
  await db.insert(workspaceMembers).values({ workspaceId: ws.id, userId: member.id, role: "member" });
  const detail = await ok("GET", `/workspaces/${ws.id}`, undefined, owner.token);
  const channelId = detail.channels[0].id as string;
  await db.insert(conversationParticipants).values({ conversationId: channelId, userId: member.id });
  return { owner, member, workspaceId: ws.id as string, channelId };
}

async function createBot(owner: Person, name: string, extra: Record<string, unknown>) {
  const res = await ok("POST", "/bots/create", { name, ...extra }, owner.token);
  createdBotUserIds.push(res.userId);
  return res as { id: string; userId: string; apiKey: string };
}

const text = (value: string) => ({ type: "text" as const, text: value });
const ref = (refId: string) => ({ type: "reference" as const, refType: "user" as const, refId });

function parts(conversationId: string, token: string, body: unknown[], extra: Record<string, unknown> = {}) {
  return req("POST", `/messages/${conversationId}`, { contentFormat: "parts-v1", parts: body, ...extra }, token);
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(getter: () => Promise<T | null | undefined>, label: string, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let last: T | null | undefined;
  while (Date.now() < deadline) {
    last = await getter();
    if (last) return last;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}; last: ${JSON.stringify(last)}`);
}

async function invokedBotIds(messageId: string) {
  const rows = await db
    .select({ botId: botInvocations.botId })
    .from(botInvocations)
    .where(eq(botInvocations.triggerMessageId, messageId))
    .orderBy(asc(botInvocations.createdAt));
  return rows.map((row) => row.botId).sort();
}

async function storedMessage(id: string) {
  const [row] = await db.select().from(messages).where(eq(messages.id, id)).limit(1);
  return row!;
}

async function messageCount(conversationId: string) {
  const rows = await db.select({ id: messages.id }).from(messages).where(eq(messages.conversationId, conversationId));
  return rows.length;
}

/** A Hermes bot that never claims, so invocations stay queued for assertions. */
async function hermesBot(owner: Person, name: string, workspaceId: string) {
  return createBot(owner, name, { kind: "hermes", workspaceId });
}

function startWebhookServer() {
  const requests: any[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push(JSON.parse(await request.text()));
      return new Response("ok");
    },
  });
  return { requests, url: `http://localhost:${server.port}/hook`, stop: () => server.stop() };
}

// -- Contract and storage -----------------------------------------------------

describe("parts-v1 messages: contract and storage", () => {
  test("stores parts with label snapshots and derives readable content, preserving Unicode and lines", async () => {
    const f = await workspace("Store");
    const sent = await parts(f.channelId, f.owner.token, [
      text("  Hi "),
      ref(f.member.id),
      text(" 👋🏽 Zoë — مرحبا\n  indented\n"),
      ref(f.member.id),
      text("  "),
    ]);
    expect(sent.status).toBe(200);
    expect(sent.body.contentFormat).toBe("parts-v1");
    // Trimmed at the edges like legacy content; untouched inside.
    expect(sent.body.content).toBe(`Hi @${f.member.name} 👋🏽 Zoë — مرحبا\n  indented\n@${f.member.name}`);
    expect(sent.body.parts).toEqual([
      text("Hi "),
      { ...ref(f.member.id), label: f.member.name, targetType: "human" },
      text(" 👋🏽 Zoë — مرحبا\n  indented\n"),
      { ...ref(f.member.id), label: f.member.name, targetType: "human" },
    ]);

    const row = await storedMessage(sent.body.id);
    expect(row.contentFormat).toBe("parts-v1");
    expect(row.content).toBe(sent.body.content);

    // History returns the same shape.
    const history = await ok("GET", `/messages/${f.channelId}`, undefined, f.member.token);
    expect(history.at(-1)).toMatchObject({ id: sent.body.id, contentFormat: "parts-v1", parts: sent.body.parts });
  });

  test("legacy content requests stay legacy-text, and old rows default to legacy-text", async () => {
    const f = await workspace("Legacy");
    const legacy = await ok("POST", `/messages/${f.channelId}`, { content: `@${f.member.name} hi` }, f.owner.token);
    expect(legacy.contentFormat).toBeUndefined();
    expect((await storedMessage(legacy.id)).contentFormat).toBe("legacy-text");

    // A row written without the column (as before the migration) reads as legacy.
    const [inserted] = await db
      .insert(messages)
      .values({ conversationId: f.channelId, senderId: f.owner.id, content: "pre-migration" })
      .returning();
    expect(inserted!.contentFormat).toBe("legacy-text");
  });

  test("a request carries parts or content, never both, and parts are strictly validated", async () => {
    const f = await workspace("Shape");
    const both = await req(
      "POST",
      `/messages/${f.channelId}`,
      { content: "hi", contentFormat: "parts-v1", parts: [text("hi")] },
      f.owner.token,
    );
    expect(both.status).toBe(400);
    const noFormat = await req("POST", `/messages/${f.channelId}`, { parts: [text("hi")] }, f.owner.token);
    expect(noFormat.status).toBe(400);
    const extraField = await parts(f.channelId, f.owner.token, [{ ...ref(f.member.id), label: "Spoofed" }]);
    expect(extraField.status).toBe(400);
    const unknownType = await parts(f.channelId, f.owner.token, [{ type: "reference", refType: "channel", refId: f.channelId }]);
    expect(unknownType.status).toBe(400);
    const empty = await parts(f.channelId, f.owner.token, [text("   ")]);
    expect(empty.status).toBe(400);
    expect(await messageCount(f.channelId)).toBe(0);
  });

  test("rejects invalid, foreign-workspace and non-participant references with no message stored", async () => {
    const f = await workspace("Authz");
    const other = await workspace("Foreign");
    const privateChannel = await ok(
      "POST",
      "/conversations/channel",
      { workspaceId: f.workspaceId, name: "board", isPrivate: true, memberIds: [] },
      f.owner.token,
    );
    const removed = await register("Authz Removed");
    // In the channel's participants but no longer a workspace member.
    await db.insert(conversationParticipants).values({ conversationId: f.channelId, userId: removed.id });

    const cases: [string, string, unknown[]][] = [
      ["unknown user", f.channelId, [text("hi "), ref(crypto.randomUUID())]],
      ["foreign workspace user", f.channelId, [text("hi "), ref(other.member.id)]],
      ["workspace member outside a private channel", privateChannel.id, [text("hi "), ref(f.member.id)]],
      ["participant who left the workspace", f.channelId, [text("hi "), ref(removed.id)]],
      ["one bad reference among good ones", f.channelId, [ref(f.member.id), text(" and "), ref(other.owner.id)]],
    ];
    for (const [label, conversationId, body] of cases) {
      const res = await parts(conversationId, f.owner.token, body);
      expect(res.status, label).toBe(400);
      // The same message for every case: nothing is disclosed about the ID.
      expect(res.body.error, label).toBe("A mentioned person or agent is not in this conversation");
    }
    expect(await messageCount(f.channelId)).toBe(0);
    expect(await messageCount(privateChannel.id)).toBe(0);
  });

  test("idempotency compares parts: same text to another ID conflicts, an exact retry replays", async () => {
    const f = await workspace("Idem");
    const sam1 = await register("Sam");
    const sam2 = await register("Sam");
    for (const sam of [sam1, sam2]) {
      await db.insert(workspaceMembers).values({ workspaceId: f.workspaceId, userId: sam.id, role: "member" });
      await db.insert(conversationParticipants).values({ conversationId: f.channelId, userId: sam.id });
    }
    const clientMessageId = crypto.randomUUID();
    const first = await parts(f.channelId, f.owner.token, [text("Hi "), ref(sam1.id)], { clientMessageId });
    expect(first.status).toBe(200);
    const replay = await parts(f.channelId, f.owner.token, [text("Hi "), ref(sam1.id)], { clientMessageId });
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);

    const otherTarget = await parts(f.channelId, f.owner.token, [text("Hi "), ref(sam2.id)], { clientMessageId });
    expect(otherTarget.status).toBe(409);
    const asLegacy = await req("POST", `/messages/${f.channelId}`, { content: "Hi @Sam", clientMessageId }, f.owner.token);
    expect(asLegacy.status).toBe(409);
    expect(await messageCount(f.channelId)).toBe(1);
  });
});

// -- WebSocket parity -----------------------------------------------------------

function openSocket(token: string) {
  const socket = new WebSocket(`${baseUrl.replace("http://", "ws://")}/ws`);
  const events: any[] = [];
  const waiters: { match: (event: any) => boolean; resolve: (event: any) => void }[] = [];
  socket.addEventListener("message", (event) => {
    const parsed = JSON.parse(String(event.data));
    events.push(parsed);
    for (const waiter of [...waiters]) {
      if (waiter.match(parsed)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(parsed);
      }
    }
  });
  const next = (match: (event: any) => boolean, label: string) =>
    new Promise<any>((resolve, reject) => {
      const found = events.find(match);
      if (found) return resolve(found);
      const timer = setTimeout(() => reject(new Error(`websocket: no ${label}`)), 8_000);
      waiters.push({ match, resolve: (event) => { clearTimeout(timer); resolve(event); } });
    });
  const ready = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "auth", token }));
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => reject(new Error("websocket failed")), { once: true });
  }).then(() => next((event) => event.type === "auth_ok", "auth_ok"));
  return { socket, next, ready };
}

describe("parts-v1 over WebSocket", () => {
  test("stores the same canonical message as REST and fans it out with parts", async () => {
    const f = await workspace("WS");
    const sender = openSocket(f.owner.token);
    const receiver = openSocket(f.member.token);
    await Promise.all([sender.ready, receiver.ready]);
    try {
      const clientMessageId = crypto.randomUUID();
      sender.socket.send(
        JSON.stringify({
          type: "send_message",
          conversationId: f.channelId,
          clientMessageId,
          contentFormat: "parts-v1",
          parts: [text("Ping "), ref(f.member.id)],
        }),
      );
      const delivered = await receiver.next(
        (event) => event.type === "new_message" && event.clientMessageId === clientMessageId,
        "new_message",
      );
      expect(delivered.message).toMatchObject({
        content: `Ping @${f.member.name}`,
        contentFormat: "parts-v1",
        parts: [text("Ping "), { ...ref(f.member.id), label: f.member.name, targetType: "human" }],
      });

      const viaRest = await parts(f.channelId, f.owner.token, [text("Ping "), ref(f.member.id)]);
      const [wsRow, restRow] = await Promise.all([storedMessage(delivered.message.id), storedMessage(viaRest.body.id)]);
      expect(wsRow.content).toBe(restRow.content);
      expect(wsRow.parts).toEqual(restRow.parts);
      expect(wsRow.contentFormat).toBe(restRow.contentFormat);

      // A rejected reference answers the sender's clientMessageId.
      const failedId = crypto.randomUUID();
      sender.socket.send(
        JSON.stringify({
          type: "send_message",
          conversationId: f.channelId,
          clientMessageId: failedId,
          contentFormat: "parts-v1",
          parts: [text("hi "), ref(crypto.randomUUID())],
        }),
      );
      const error = await sender.next(
        (event) => event.type === "message_error" && event.clientMessageId === failedId,
        "message_error",
      );
      expect(error.message).toBe("A mentioned person or agent is not in this conversation");

      // Parts and content together are refused before anything is stored.
      const bothId = crypto.randomUUID();
      sender.socket.send(
        JSON.stringify({
          type: "send_message",
          conversationId: f.channelId,
          clientMessageId: bothId,
          content: "hi",
          contentFormat: "parts-v1",
          parts: [text("hi")],
        }),
      );
      const refused = await sender.next(
        (event) => event.type === "message_error" && event.clientMessageId === bothId,
        "message_error for parts+content",
      );
      expect(refused.message).toBe("Send either parts or content, not both");
      expect(await messageCount(f.channelId)).toBe(2);
    } finally {
      sender.socket.close();
      receiver.socket.close();
    }
  });
});

// -- Effects from IDs ---------------------------------------------------------

describe("parts-v1 effects come from IDs", () => {
  test("two bots with the same name: picking one invokes only that ID; a typed @Name invokes nobody", async () => {
    const f = await workspace("SameName");
    const first = await hermesBot(f.owner, "Twin", f.workspaceId);
    const second = await hermesBot(f.owner, "Twin", f.workspaceId);

    const picked = await parts(f.channelId, f.owner.token, [text("please "), ref(second.userId), text(" and "), ref(second.userId)]);
    expect(picked.status).toBe(200);
    await waitFor(async () => ((await invokedBotIds(picked.body.id)).length ? true : null), "invocation");
    await sleep(150);
    expect(await invokedBotIds(picked.body.id)).toEqual([second.id]);

    const typed = await parts(f.channelId, f.owner.token, [text("hey @Twin, typed by hand")]);
    expect(typed.status).toBe(200);
    // The legacy path would invoke both bots for the same text.
    const legacy = await ok("POST", `/messages/${f.channelId}`, { content: "hey @Twin, typed by hand" }, f.owner.token);
    await waitFor(async () => ((await invokedBotIds(legacy.id)).length === 2 ? true : null), "legacy invocations");
    expect(await invokedBotIds(legacy.id)).toEqual([first.id, second.id].sort());
    expect(await invokedBotIds(typed.body.id)).toEqual([]);
  });

  test("renaming the target between typing and sending does not change who is targeted", async () => {
    const f = await workspace("Rename");
    const bot = await hermesBot(f.owner, "Scout", f.workspaceId);
    // The composer still shows "@Scout"; the bot is renamed before the send.
    await ok("PATCH", `/bots/${bot.id}`, { name: "Ranger" }, f.owner.token);
    const sent = await parts(f.channelId, f.owner.token, [ref(bot.userId), text(" please check")]);
    expect(sent.status).toBe(200);
    // The label snapshot is the current name at send time.
    expect(sent.body.content).toBe("@Ranger please check");
    await waitFor(async () => ((await invokedBotIds(sent.body.id)).length ? true : null), "invocation");
    expect(await invokedBotIds(sent.body.id)).toEqual([bot.id]);

    // Renamed again after sending: history keeps the snapshot, routing is unchanged.
    await ok("PATCH", `/bots/${bot.id}`, { name: "Pathfinder" }, f.owner.token);
    expect((await storedMessage(sent.body.id)).parts).toEqual([
      { ...ref(bot.userId), label: "Ranger", targetType: "bot" },
      text(" please check"),
    ]);
  });

  test("Hermes receives the prompt without its own mention, with lines and indentation kept", async () => {
    const f = await workspace("Prompt");
    const bot = await hermesBot(f.owner, "Koda", f.workspaceId);
    const sent = await parts(f.channelId, f.owner.token, [
      ref(bot.userId),
      text(" summarize:\n  - first\n  - second, ask "),
      ref(f.member.id),
    ]);
    expect(sent.status).toBe(200);
    await waitFor(async () => ((await invokedBotIds(sent.body.id)).length ? true : null), "invocation");
    const claim = await ok("GET", "/hermes-platform/events?limit=5", undefined, bot.apiKey);
    const event = claim.events.find((candidate: any) => candidate.messageId === sent.body.id);
    expect(event.text).toBe(`summarize:\n  - first\n  - second, ask @${f.member.name}`);
    expect(event.contentFormat).toBe("parts-v1");
    expect(event.parts).toEqual([
      { ...ref(bot.userId), label: "Koda", targetType: "bot" },
      text(" summarize:\n  - first\n  - second, ask "),
      { ...ref(f.member.id), label: f.member.name, targetType: "human" },
    ]);
  });

  test("a direct Hermes DM still invokes without a mention", async () => {
    const f = await workspace("DirectDM");
    const bot = await hermesBot(f.owner, "Helper", f.workspaceId);
    const dm = await ok("POST", "/conversations/dm", { workspaceId: f.workspaceId, otherUserId: bot.userId }, f.owner.token);
    const sent = await parts(dm.id, f.owner.token, [text("no mention needed")]);
    expect(sent.status).toBe(200);
    await waitFor(async () => ((await invokedBotIds(sent.body.id)).length ? true : null), "DM invocation");
    expect(await invokedBotIds(sent.body.id)).toEqual([bot.id]);
  });

  test("bot-to-bot: a Hermes reference to another bot invokes that bot only", async () => {
    const f = await workspace("Handoff");
    const first = await hermesBot(f.owner, "Lead", f.workspaceId);
    const second = await hermesBot(f.owner, "Helper", f.workspaceId);
    const third = await hermesBot(f.owner, "Helper", f.workspaceId);
    const published = await ok(
      "POST",
      "/hermes-platform/messages",
      {
        conversationId: f.channelId,
        contentFormat: "parts-v1",
        parts: [ref(third.userId), text(" please take this")],
        platformMessageId: `handoff-${crypto.randomUUID()}`,
      },
      first.apiKey,
    );
    await waitFor(async () => ((await invokedBotIds(published.messageId)).length ? true : null), "handoff invocation");
    await sleep(150);
    // Only the referenced "Helper", not the other bot of the same name.
    expect(await invokedBotIds(published.messageId)).toEqual([third.id]);
    expect(await invokedBotIds(published.messageId)).not.toContain(second.id);
    expect((await storedMessage(published.messageId)).content).toBe("@Helper please take this");

    // A bot cannot reference someone outside the conversation either.
    const outsider = await register("Handoff Outsider");
    const refused = await req(
      "POST",
      "/hermes-platform/messages",
      { conversationId: f.channelId, contentFormat: "parts-v1", parts: [ref(outsider.id)] },
      first.apiKey,
    );
    expect(refused.status).toBe(400);
  });

  test("webhook bots receive the parts so they can tell who was mentioned", async () => {
    const webhook = startWebhookServer();
    try {
      const f = await workspace("Webhook");
      const bot = await createBot(f.owner, "Hooky", { webhookUrl: webhook.url });
      await ok("POST", `/bots/${bot.id}/workspaces`, { workspaceId: f.workspaceId }, f.owner.token);
      const sent = await parts(f.channelId, f.owner.token, [ref(bot.userId), text(" hi")]);
      await waitFor(async () => (webhook.requests.length ? true : null), "webhook delivery");
      expect(webhook.requests[0].message).toMatchObject({
        id: sent.body.id,
        content: "@Hooky hi",
        contentFormat: "parts-v1",
        parts: [{ ...ref(bot.userId), label: "Hooky", targetType: "bot" }, text(" hi")],
      });
    } finally {
      webhook.stop();
    }
  });

  test("thread following: a picked mention follows the thread, a typed @Name does not", async () => {
    const f = await workspace("Follow");
    const third = await register("Follow Third");
    await db.insert(workspaceMembers).values({ workspaceId: f.workspaceId, userId: third.id, role: "member" });
    await db.insert(conversationParticipants).values({ conversationId: f.channelId, userId: third.id });
    const root = await ok("POST", `/messages/${f.channelId}`, { content: "Launch plan" }, f.owner.token);
    await parts(f.channelId, f.owner.token, [text("cc "), ref(f.member.id), text(` and typed @${third.name}`)], {
      parentMessageId: root.id,
    });
    const followers = await db
      .select({ userId: messageThreadFollowers.userId })
      .from(messageThreadFollowers)
      .where(and(eq(messageThreadFollowers.rootMessageId, root.id), eq(messageThreadFollowers.following, true)));
    const ids = followers.map((row) => row.userId);
    expect(ids).toContain(f.member.id);
    expect(ids).not.toContain(third.id);
  });

  test("a legacy content request still routes by name as before", async () => {
    const f = await workspace("LegacyRoute");
    const bot = await hermesBot(f.owner, "Oldie", f.workspaceId);
    const sent = await ok("POST", `/messages/${f.channelId}`, { content: "@Oldie please" }, f.owner.token);
    await waitFor(async () => ((await invokedBotIds(sent.id)).length ? true : null), "legacy invocation");
    expect(await invokedBotIds(sent.id)).toEqual([bot.id]);
  });
});

// -- MCP ----------------------------------------------------------------------

describe("parts-v1 through MCP", () => {
  async function mcpCall(token: string, name: string, args: Record<string, unknown>) {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const raw = await response.text();
    const line = raw.split("\n").find((candidate) => candidate.startsWith("data:"));
    return JSON.parse(line ? line.slice(5) : raw).result;
  }

  test("send_message accepts parts with IDs and keeps legacy content routing", async () => {
    const f = await workspace("MCP");
    const bot = await hermesBot(f.owner, "Mcpbot", f.workspaceId);
    const structured = await mcpCall(f.owner.token, "send_message", {
      conversationId: f.channelId,
      contentFormat: "parts-v1",
      parts: [ref(bot.userId), text(" from MCP")],
    });
    const sent = JSON.parse(structured.content[0].text);
    expect(sent.content).toBe("@Mcpbot from MCP");
    await waitFor(async () => ((await invokedBotIds(sent.id)).length ? true : null), "MCP invocation");
    expect(await invokedBotIds(sent.id)).toEqual([bot.id]);

    const both = await mcpCall(f.owner.token, "send_message", {
      conversationId: f.channelId,
      content: "x",
      contentFormat: "parts-v1",
      parts: [text("x")],
    });
    expect(both.isError).toBe(true);

    const legacy = await mcpCall(f.owner.token, "send_message", { conversationId: f.channelId, content: "@Mcpbot legacy" });
    const legacySent = JSON.parse(legacy.content[0].text);
    await waitFor(async () => ((await invokedBotIds(legacySent.id)).length ? true : null), "MCP legacy invocation");
    expect(await invokedBotIds(legacySent.id)).toEqual([bot.id]);
  });
});

// -- Hermes prompt projection (pure) -----------------------------------------

describe("hermesPromptFromParts", () => {
  const BOT = "bot-user";
  const label = (refId: string, name: string) => ({ type: "reference" as const, refType: "user" as const, refId, label: name });
  test.each([
    ["leading mention", [label(BOT, "Koda"), { type: "text" as const, text: " do it" }], "do it"],
    ["trailing mention", [{ type: "text" as const, text: "do it " }, label(BOT, "Koda")], "do it"],
    ["mention between words", [{ type: "text" as const, text: "please " }, label(BOT, "Koda"), { type: "text" as const, text: " do it" }], "please do it"],
    ["mention on its own line", [label(BOT, "Koda"), { type: "text" as const, text: "\n  keep\n    indent" }], "  keep\n    indent"],
    ["other references kept", [label(BOT, "Koda"), { type: "text" as const, text: " ask " }, label("ada", "Ada")], "ask @Ada"],
    ["literal @Koda text kept", [label(BOT, "Koda"), { type: "text" as const, text: " say @Koda literally" }], "say @Koda literally"],
  ])("%s", (_name, input, expected) => {
    expect(hermesPromptFromParts(input, BOT)).toBe(expected);
  });
});
