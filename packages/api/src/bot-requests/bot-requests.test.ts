import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { and, eq, inArray } from "drizzle-orm";
import crypto from "crypto";
import type { BotRequestPublic } from "@thechat/shared";
import { db } from "../db";
import { queueJobs as eventOutbox } from '../async/job-schema';
import {
  botInvocations,
  botRequests,
  conversationParticipants,

  users,
  workspaceMembers,
  workspaces,
} from "../db/schema";
import { authRoutes } from "../auth";
import { workspaceRoutes } from "../workspaces";
import { conversationRoutes } from "../conversations";
import { messageRoutes } from "../messages";
import { botRoutes } from "../bots";
import { hermesPlatformRoutes } from "../hermes-platform";
import { botRequestRoutes, inboxRoutes } from ".";
import {
  closeBotProgressStoreForTests,
  createLocalBotProgressStoreForTests,
  setBotProgressStoreForTests,
} from "../services/bot-progress-store";
import { closeBotRuntimeForTests, signWebhookPayload } from "../services/bot-runtime";
import {
  closeRealtimeBusForTests,
  LocalRealtimeBus,
  setRealtimeBusForTests,
  type RealtimeEvent,
} from "../realtime";
import { closeDomainEventRuntime, startDomainEventRuntime } from "../events/runtime";
import { BOT_REQUEST_ANSWERED_EVENT_TYPE } from "./events";
import { registerTools } from "../mcp/tools";
import type { McpUser } from "../mcp/auth";

const app = new Elysia()
  .use(authRoutes)
  .use(workspaceRoutes)
  .use(conversationRoutes)
  .use(messageRoutes)
  .use(botRoutes)
  .use(hermesPlatformRoutes)
  .use(botRequestRoutes)
  .use(inboxRoutes);

const createdUserEmails: string[] = [];
const createdWorkspaceIds: string[] = [];
const createdBotUserIds: string[] = [];
const realtimeEvents: RealtimeEvent[] = [];
const servers: Array<{ stop: () => void }> = [];

beforeAll(async () => {
  await setBotProgressStoreForTests(createLocalBotProgressStoreForTests());
  const bus = new LocalRealtimeBus();
  await bus.subscribe((event) => {
    realtimeEvents.push(event);
  });
  await setRealtimeBusForTests(bus);
  await startDomainEventRuntime();
});

afterAll(async () => {
  for (const server of servers) server.stop();
  await closeDomainEventRuntime();
  await closeBotRuntimeForTests();
  await closeBotProgressStoreForTests();
  await closeRealtimeBusForTests();
  const humans =
    createdUserEmails.length > 0
      ? await db
          .select({ id: users.id })
          .from(users)
          .where(inArray(users.email, createdUserEmails))
      : [];
  const actorIds = [...createdBotUserIds, ...humans.map((user) => user.id)];
  if (actorIds.length > 0) {
    await db.delete(eventOutbox).where(inArray(eventOutbox.actorId, actorIds));
  }
  if (createdWorkspaceIds.length > 0) {
    await db.delete(eventOutbox).where(inArray(eventOutbox.tenantId, createdWorkspaceIds));
  }
  for (const id of createdBotUserIds) await db.delete(users).where(eq(users.id, id));
  for (const id of createdWorkspaceIds) await db.delete(workspaces).where(eq(workspaces.id, id));
  for (const human of humans) await db.delete(users).where(eq(users.id, human.id));
});

async function req(method: string, path: string, body?: unknown, token?: string) {
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
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, body: json };
}

async function registerUser(name: string) {
  const email = `bot-requests-${crypto.randomUUID()}@test.com`;
  createdUserEmails.push(email);
  const res = await req("POST", "/auth/register", { name, email, password: "password123" });
  expect(res.status).toBe(200);
  return { token: res.body.accessToken as string, user: res.body.user as { id: string; name: string } };
}

async function createWorkspace(token: string, name: string) {
  const ws = await req("POST", "/workspaces/create", { name }, token);
  expect(ws.status).toBe(200);
  createdWorkspaceIds.push(ws.body.id);
  const detail = await req("GET", `/workspaces/${ws.body.id}`, undefined, token);
  expect(detail.status).toBe(200);
  return { workspaceId: ws.body.id as string, channelId: detail.body.channels[0].id as string };
}

async function createBot(
  ownerToken: string,
  name: string,
  extra: Record<string, unknown> = {},
) {
  const res = await req("POST", "/bots/create", { name, ...extra }, ownerToken);
  expect(res.status).toBe(200);
  createdBotUserIds.push(res.body.userId);
  return res.body as {
    id: string;
    userId: string;
    apiKey: string;
    webhookSecret: string;
  };
}

async function joinWorkspace(workspaceId: string, userId: string, channelId: string) {
  await db.insert(workspaceMembers).values({ workspaceId, userId, role: "member" });
  await db.insert(conversationParticipants).values({ conversationId: channelId, userId });
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(get: () => Promise<T | null | undefined>, label: string, ms = 8_000) {
  const deadline = Date.now() + ms;
  let last: T | null | undefined;
  while (Date.now() < deadline) {
    last = await get();
    if (last) return last;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}; last: ${JSON.stringify(last)}`);
}

/** A Hermes-style approval: every choice Hermes offers, including Always. */
function hermesApproval(clientKey: string, extra: Record<string, unknown> = {}) {
  return {
    clientKey,
    kind: "approval",
    title: "Run a dangerous command",
    body: "recursive delete",
    details: { command: "rm -rf /tmp/old", cwd: "/srv" },
    response: { type: "choice", choices: ["once", "session", "always", "deny"] },
    orderGroup: "session-1",
    ...extra,
  };
}

/** Owner, a Hermes bot in the workspace, and their DM. */
async function hermesFixture(label: string) {
  const owner = await registerUser(`${label} owner`);
  const { workspaceId, channelId } = await createWorkspace(owner.token, `${label} ws`);
  const bot = await createBot(owner.token, `${label} Hermes`, { kind: "hermes", workspaceId });
  const dm = await req(
    "POST",
    "/conversations/dm",
    { workspaceId, otherUserId: bot.userId },
    owner.token,
  );
  expect(dm.status).toBe(200);
  return { owner, workspaceId, channelId, bot, dmId: dm.body.id as string };
}

describe("bot requests: create and read", () => {
  test("creates in the owner DM by default and replays one clientKey idempotently", async () => {
    const f = await hermesFixture("Create");
    const created = await req("POST", "/bot-requests", hermesApproval("create-1"), f.bot.apiKey);
    expect(created.status).toBe(201);
    expect(created.body.created).toBe(true);
    const request = created.body.request;
    expect(request).toMatchObject({
      conversationId: f.dmId,
      kind: "approval",
      status: "open",
      clientKey: "create-1",
      response: { type: "choice", choices: ["once", "session", "always", "deny"] },
    });

    // Replaying the same create returns the same row.
    const replay = await req("POST", "/bot-requests", hermesApproval("create-1"), f.bot.apiKey);
    expect(replay.status).toBe(200);
    expect(replay.body.created).toBe(false);
    expect(replay.body.request.id).toBe(request.id);

    // Content is immutable: reusing a key for something else is a conflict.
    const changed = await req(
      "POST",
      "/bot-requests",
      hermesApproval("create-1", { title: "Something else" }),
      f.bot.apiKey,
    );
    expect(changed.status).toBe(409);

    // The participant sees it; the bot's view carries the clientKey.
    const humanView = await req("GET", `/bot-requests/${request.id}`, undefined, f.owner.token);
    expect(humanView.status).toBe(200);
    expect(humanView.body.request.clientKey).toBeUndefined();
    const botView = await req("GET", `/bot-requests/${request.id}`, undefined, f.bot.apiKey);
    expect(botView.body.request.clientKey).toBe("create-1");

    const published = realtimeEvents.find(
      (event) =>
        event.event.type === "bot_request_updated" &&
        event.event.request.id === request.id,
    );
    expect(published?.targetUserIds).toEqual([f.owner.user.id]);
  });

  test("enforces who may create, read and answer", async () => {
    const f = await hermesFixture("Access");
    const outsider = await registerUser("Access outsider");
    expect(
      (await req("POST", "/bot-requests", hermesApproval("human-create"), f.owner.token)).status,
    ).toBe(403);
    const { body } = await req("POST", "/bot-requests", hermesApproval("access-1"), f.bot.apiKey);
    const id = body.request.id as string;

    expect((await req("GET", `/bot-requests/${id}`, undefined, outsider.token)).status).toBe(404);
    expect(
      (await req("POST", `/bot-requests/${id}/answer`, { choice: "once" }, outsider.token)).status,
    ).toBe(404);
    // A bot token can never answer, even the bot's own request.
    expect(
      (await req("POST", `/bot-requests/${id}/answer`, { choice: "once" }, f.bot.apiKey)).status,
    ).toBe(403);
    // Another bot cannot see it.
    const other = await createBot(f.owner.token, "Access other bot");
    expect((await req("GET", `/bot-requests/${id}`, undefined, other.apiKey)).status).toBe(404);
    expect((await req("GET", `/bot-requests/${id}`)).status).toBe(401);
  });

  test("validates answers against the response spec", async () => {
    const f = await hermesFixture("Validate");
    const { body } = await req("POST", "/bot-requests", hermesApproval("validate-1"), f.bot.apiKey);
    const id = body.request.id as string;
    for (const answer of [
      { choice: "sometimes" },
      { text: "yes please" },
      { choice: "once", text: "and text" },
      {},
    ]) {
      expect((await req("POST", `/bot-requests/${id}/answer`, answer, f.owner.token)).status).toBe(400);
    }

    const question = await req(
      "POST",
      "/bot-requests",
      {
        clientKey: "validate-q",
        kind: "question",
        title: "Which regions?",
        response: { type: "choice", choices: ["EU", "US", "APAC"], multiple: true, allowText: true },
      },
      f.bot.apiKey,
    );
    expect(question.status).toBe(201);
    const qid = question.body.request.id as string;
    expect(
      (await req("POST", `/bot-requests/${qid}/answer`, { choices: ["EU", "Mars"] }, f.owner.token)).status,
    ).toBe(400);
    const answered = await req(
      "POST",
      `/bot-requests/${qid}/answer`,
      { choices: ["EU", "US"] },
      f.owner.token,
    );
    expect(answered.status).toBe(200);
    expect(answered.body.request.answer).toEqual({ choices: ["EU", "US"] });
  });
});

describe("bot requests: answering", () => {
  test("Always allow is answerable and the first answer wins atomically", async () => {
    // Two people in a shared channel race on the same request.
    const owner = await registerUser("Always owner");
    const second = await registerUser("Always second");
    const { workspaceId, channelId } = await createWorkspace(owner.token, "Always ws");
    await joinWorkspace(workspaceId, second.user.id, channelId);
    const raceBot = await createBot(owner.token, "Always bot");
    expect(
      (await req("POST", `/bots/${raceBot.id}/workspaces`, { workspaceId }, owner.token)).status,
    ).toBe(200);
    const { body } = await req(
      "POST",
      "/bot-requests",
      hermesApproval("always-1", { conversationId: channelId }),
      raceBot.apiKey,
    );
    expect(body.request.conversationId).toBe(channelId);
    const id = body.request.id as string;

    const [first, racer] = await Promise.all([
      req("POST", `/bot-requests/${id}/answer`, { choice: "always" }, owner.token),
      req("POST", `/bot-requests/${id}/answer`, { choice: "deny" }, second.token),
    ]);
    const statuses = [first.status, racer.status].sort();
    expect(statuses).toEqual([200, 409]);
    const winner = first.status === 200 ? first : racer;
    const loser = first.status === 200 ? racer : first;
    expect(winner.body.request.status).toBe("answered");
    expect(loser.body.error).toMatch(/^Already answered by /);
    expect(loser.body.request.answer).toEqual(winner.body.request.answer);

    // Exactly one outbox event for the one stored answer.
    const events = await db
      .select({ id: eventOutbox.id, partitionKey: eventOutbox.partitionKey })
      .from(eventOutbox)
      .where(
        and(
          eq(eventOutbox.eventType, BOT_REQUEST_ANSWERED_EVENT_TYPE),
          eq(eventOutbox.aggregateId, id),
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0]!.partitionKey).toBeNull(); // Answer delivery is deliberately unordered.

    // Owner answering with Always in a fresh DM request is stored verbatim.
    const f = await hermesFixture("Always DM");
    const fresh = await req("POST", "/bot-requests", hermesApproval("always-2", { orderGroup: null }), f.bot.apiKey);
    const always = await req(
      "POST",
      `/bot-requests/${fresh.body.request.id}/answer`,
      { choice: "always" },
      f.owner.token,
    );
    expect(always.status).toBe(200);
    expect(always.body.request.answer).toEqual({ choice: "always" });
    expect(always.body.request.answeredBy).toEqual({ id: f.owner.user.id, name: f.owner.user.name });
  });

  test("any channel participant may answer unless one person is addressed", async () => {
    const owner = await registerUser("Channel owner");
    const member = await registerUser("Channel member");
    const outsider = await registerUser("Channel outsider");
    const { workspaceId, channelId } = await createWorkspace(owner.token, "Channel ws");
    await joinWorkspace(workspaceId, member.user.id, channelId);
    const bot = await createBot(owner.token, "Channel bot");
    expect(
      (await req("POST", `/bots/${bot.id}/workspaces`, { workspaceId }, owner.token)).status,
    ).toBe(200);

    const open = await req(
      "POST",
      "/bot-requests",
      { clientKey: "channel-open", kind: "question", title: "Ship it?", conversationId: channelId },
      bot.apiKey,
    );
    expect(open.status).toBe(201);
    expect(open.body.request.conversationType).toBe("group");
    // Not the bot owner, just someone in the channel.
    const answered = await req(
      "POST",
      `/bot-requests/${open.body.request.id}/answer`,
      { text: "Ship it" },
      member.token,
    );
    expect(answered.status).toBe(200);
    expect(answered.body.request.answeredBy.id).toBe(member.user.id);
    expect(
      (await req("GET", `/bot-requests/${open.body.request.id}`, undefined, outsider.token)).status,
    ).toBe(404);

    const addressed = await req(
      "POST",
      "/bot-requests",
      {
        clientKey: "channel-addressed",
        kind: "approval",
        title: "Owner only",
        conversationId: channelId,
        audienceUserId: owner.user.id,
      },
      bot.apiKey,
    );
    expect(addressed.status).toBe(201);
    const addressedId = addressed.body.request.id as string;
    expect(
      (await req("POST", `/bot-requests/${addressedId}/answer`, { choice: "approve" }, member.token)).status,
    ).toBe(403);

    // The member's inbox skips what is addressed to someone else.
    const memberInbox = await req("GET", "/inbox", undefined, member.token);
    expect(memberInbox.status).toBe(200);
    expect(memberInbox.body.open.map((r: BotRequestPublic) => r.id)).not.toContain(addressedId);
    expect(memberInbox.body.recent.map((r: BotRequestPublic) => r.id)).toContain(open.body.request.id);
    const ownerInbox = await req("GET", "/inbox", undefined, owner.token);
    expect(ownerInbox.body.open.map((r: BotRequestPublic) => r.id)).toContain(addressedId);

    expect(
      (await req("POST", `/bot-requests/${addressedId}/answer`, { choice: "approve" }, owner.token)).status,
    ).toBe(200);
    // Bot tokens cannot read a human inbox.
    expect((await req("GET", "/inbox", undefined, bot.apiKey)).status).toBe(403);
  });

  test("requests in one order group are answered oldest first", async () => {
    const f = await hermesFixture("Order");
    const first = await req("POST", "/bot-requests", hermesApproval("order-1"), f.bot.apiKey);
    await sleep(5);
    const second = await req("POST", "/bot-requests", hermesApproval("order-2"), f.bot.apiKey);
    const blocked = await req(
      "POST",
      `/bot-requests/${second.body.request.id}/answer`,
      { choice: "once" },
      f.owner.token,
    );
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/earlier request/);
    expect(
      (await req("POST", `/bot-requests/${first.body.request.id}/answer`, { choice: "once" }, f.owner.token)).status,
    ).toBe(200);
    expect(
      (await req("POST", `/bot-requests/${second.body.request.id}/answer`, { choice: "deny" }, f.owner.token)).status,
    ).toBe(200);
  });
});

describe("bot requests: lifecycle", () => {
  test("cancel is idempotent and closes the card", async () => {
    const f = await hermesFixture("Cancel");
    const { body } = await req("POST", "/bot-requests", hermesApproval("cancel-1"), f.bot.apiKey);
    const id = body.request.id as string;
    const cancelled = await req(
      "POST",
      `/bot-requests/${id}/cancel`,
      { reason: "Approval timed out." },
      f.bot.apiKey,
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.request).toMatchObject({ status: "cancelled", cancelReason: "Approval timed out." });
    expect((await req("POST", `/bot-requests/${id}/cancel`, {}, f.bot.apiKey)).status).toBe(200);
    const late = await req("POST", `/bot-requests/${id}/answer`, { choice: "once" }, f.owner.token);
    expect(late.status).toBe(409);
    expect(late.body.error).toBe("Approval timed out.");
    // Humans cannot cancel a bot's request.
    const other = await req("POST", "/bot-requests", hermesApproval("cancel-2", { orderGroup: null }), f.bot.apiKey);
    expect((await req("POST", `/bot-requests/${other.body.request.id}/cancel`, {}, f.owner.token)).status).toBe(403);
    await req("POST", `/bot-requests/${other.body.request.id}/answer`, { choice: "once" }, f.owner.token);
    // An answered request must be acknowledged, not cancelled.
    expect((await req("POST", `/bot-requests/${other.body.request.id}/cancel`, {}, f.bot.apiKey)).status).toBe(409);
  });

  test("expires at its deadline and rejects late answers", async () => {
    const f = await hermesFixture("Expire");
    const { body } = await req(
      "POST",
      "/bot-requests",
      hermesApproval("expire-1", { expiresAt: new Date(Date.now() + 1_200).toISOString() }),
      f.bot.apiKey,
    );
    const id = body.request.id as string;
    await sleep(1_400);
    const late = await req("POST", `/bot-requests/${id}/answer`, { choice: "once" }, f.owner.token);
    expect(late.status).toBe(409);
    expect(late.body.request.status).toBe("expired");
    expect((await req("GET", `/bot-requests/${id}`, undefined, f.bot.apiKey)).body.request.status).toBe("expired");
    expect(
      (await req("POST", "/bot-requests", hermesApproval("expire-bad", { expiresAt: new Date(Date.now() - 1).toISOString() }), f.bot.apiKey)).status,
    ).toBe(400);
  });

  test("long-polls until the answer lands", async () => {
    const f = await hermesFixture("Wait");
    const { body } = await req("POST", "/bot-requests", hermesApproval("wait-1"), f.bot.apiKey);
    const id = body.request.id as string;
    const started = Date.now();
    const [waited] = await Promise.all([
      req("GET", `/bot-requests/${id}?wait=20`, undefined, f.bot.apiKey),
      (async () => {
        await sleep(600);
        await req("POST", `/bot-requests/${id}/answer`, { choice: "session" }, f.owner.token);
      })(),
    ]);
    expect(waited.status).toBe(200);
    expect(waited.body.request).toMatchObject({ status: "answered", answer: { choice: "session" } });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect((await req("GET", `/bot-requests/${id}?wait=61`, undefined, f.bot.apiKey)).status).toBe(400);
  });

  test("Hermes picks answers up from its poll until it acknowledges them", async () => {
    const f = await hermesFixture("Poll");
    const health = await req("GET", "/hermes-platform/health", undefined, f.bot.apiKey);
    expect(health.body.capabilities).toEqual({ botRequests: 1, secureInput: 3 });

    const { body } = await req("POST", "/bot-requests", hermesApproval("poll-1"), f.bot.apiKey);
    const id = body.request.id as string;
    expect(
      (await req("GET", "/hermes-platform/events?limit=1", undefined, f.bot.apiKey)).body.requestAnswers,
    ).toEqual([]);
    await req("POST", `/bot-requests/${id}/answer`, { choice: "always" }, f.owner.token);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      // Repeats until acked, so a lost poll response loses nothing.
      const poll = await req("GET", "/hermes-platform/events?limit=1", undefined, f.bot.apiKey);
      expect(poll.body.requestAnswers.map((r: { id: string }) => r.id)).toEqual([id]);
      expect(poll.body.requestAnswers[0]).toMatchObject({ clientKey: "poll-1", answer: { choice: "always" } });
    }
    const ack = await req("POST", `/bot-requests/${id}/ack`, { applied: true }, f.bot.apiKey);
    expect(ack.status).toBe(200);
    expect(ack.body.request).toMatchObject({ status: "delivered", deliveryApplied: true });
    expect((await req("POST", `/bot-requests/${id}/ack`, { applied: true }, f.bot.apiKey)).status).toBe(200);
    expect(
      (await req("GET", "/hermes-platform/events?limit=1", undefined, f.bot.apiKey)).body.requestAnswers,
    ).toEqual([]);

    // Listing open requests is how Hermes cleans up after a restart.
    await req("POST", "/bot-requests", hermesApproval("poll-2", { orderGroup: null }), f.bot.apiKey);
    const open = await req("GET", "/bot-requests?status=open", undefined, f.bot.apiKey);
    expect(open.body.requests.map((r: { clientKey: string }) => r.clientKey)).toEqual(["poll-2"]);
  });

  test("retired approval and clarify progress is rejected", async () => {
    const f = await hermesFixture("Retired");
    const sent = await req("POST", `/messages/${f.dmId}`, { content: "Run retired" }, f.owner.token);
    expect(sent.status).toBe(200);
    const invocationId = await waitFor(async () => {
      const claim = await req("GET", "/hermes-platform/events?limit=1", undefined, f.bot.apiKey);
      return claim.body.events?.[0]?.invocationId as string | undefined;
    }, "claimed invocation");
    for (const type of ["approval.request", "approval.resolved", "clarify.request", "clarify.resolved"]) {
      const res = await req(
        "POST",
        `/hermes-platform/invocations/${invocationId}/progress`,
        { type, status: "waiting", payload: { requestId: "x", sessionKey: "s" } },
        f.bot.apiKey,
      );
      expect(res.status).toBe(400);
    }
    // Tool activity still goes to the Redis progress stream.
    const tool = await req(
      "POST",
      `/hermes-platform/invocations/${invocationId}/progress`,
      { type: "tool.started", status: "running", toolCallId: "call-1", toolName: "terminal", label: "ls" },
      f.bot.apiKey,
    );
    expect(tool.status).toBe(200);

    // A request tied to the run is closed when the run ends.
    const created = await req(
      "POST",
      "/bot-requests",
      hermesApproval("retired-run", { invocationId, conversationId: undefined }),
      f.bot.apiKey,
    );
    expect(created.status).toBe(201);
    expect(created.body.request.invocationId).toBe(invocationId);
    expect(created.body.request.conversationId).toBe(f.dmId);
    const cancelled = await req(
      "POST",
      `/hermes-platform/invocations/${invocationId}/cancelled`,
      { reason: "stopped" },
      f.bot.apiKey,
    );
    expect(cancelled.status).toBe(200);
    const after = await req("GET", `/bot-requests/${created.body.request.id}`, undefined, f.owner.token);
    expect(after.body.request.status).toBe("cancelled");
    expect(after.body.request.cancelReason).toMatch(/run ended/);
    // Cancelled Hermes runs keep delivery status `claimed`; the completion
    // records the cancellation.
    const [row] = await db
      .select({ responseJson: botInvocations.responseJson })
      .from(botInvocations)
      .where(eq(botInvocations.id, invocationId));
    expect(row?.responseJson).toMatchObject({ completion: { type: "cancelled" } });
  });
});

describe("bot requests: webhook delivery", () => {
  test("pushes a signed answer through the outbox and records the bot's ack", async () => {
    const received: Array<{ body: string; headers: Record<string, string> }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        received.push({
          body: await request.text(),
          headers: Object.fromEntries(request.headers.entries()),
        });
        return Response.json({ applied: false, note: "The command already ran." });
      },
    });
    servers.push(server);
    const owner = await registerUser("Webhook owner");
    const { workspaceId } = await createWorkspace(owner.token, "Webhook ws");
    const bot = await createBot(owner.token, "Webhook bot", {
      webhookUrl: `http://localhost:${server.port}/hook`,
    });
    expect(
      (await req("POST", `/bots/${bot.id}/workspaces`, { workspaceId }, owner.token)).status,
    ).toBe(200);
    const created = await req(
      "POST",
      "/bot-requests",
      { clientKey: "webhook-1", kind: "review", title: "Review PR #12", workspaceId },
      bot.apiKey,
    );
    expect(created.status).toBe(201);
    const id = created.body.request.id as string;
    await req(
      "POST",
      `/bot-requests/${id}/answer`,
      { choice: "request_changes", comment: "Add tests" },
      owner.token,
    );

    const delivered = await waitFor(async () => {
      const res = await req("GET", `/bot-requests/${id}`, undefined, owner.token);
      return res.body.request.status === "delivered" ? res.body.request : null;
    }, "webhook acknowledgement");
    expect(delivered).toMatchObject({ deliveryApplied: false, deliveryNote: "The command already ran." });

    const push = received.find((item) => item.headers["x-thechat-bot-request-id"] === id)!;
    expect(push).toBeDefined();
    const payload = JSON.parse(push.body);
    expect(payload.type).toBe("thechat.bot_request.answered");
    expect(payload.request).toMatchObject({
      id,
      clientKey: "webhook-1",
      answer: { choice: "request_changes", comment: "Add tests" },
    });
    const timestamp = Number(push.headers["x-webhook-timestamp"]);
    expect(push.headers["x-webhook-signature"]).toBe(
      signWebhookPayload(push.body, bot.webhookSecret, timestamp),
    );
  });
});

describe("bot requests: MCP tools", () => {
  test("request_approval, ask_question and get_request use the same rows", async () => {
    type Handler = (
      args: Record<string, unknown>,
      extra: { authInfo?: McpUser; signal?: AbortSignal },
    ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    const tools = new Map<string, Handler>();
    registerTools({
      registerTool: (name: string, _config: unknown, handler: Handler) => {
        tools.set(name, handler);
      },
    } as unknown as Parameters<typeof registerTools>[0]);

    const f = await hermesFixture("Mcp");
    const [botUser] = await db.select().from(users).where(eq(users.id, f.bot.userId));
    const botAuth = { ...botUser!, type: "bot" } as unknown as McpUser;
    const humanAuth = { ...f.owner.user, type: "human" } as unknown as McpUser;

    const denied = await tools.get("request_approval")!(
      { title: "Deploy?", waitSeconds: 0 },
      { authInfo: humanAuth },
    );
    expect(denied.isError).toBe(true);

    const approval = await tools.get("request_approval")!(
      { title: "Deploy to production?", command: "make deploy", waitSeconds: 0 },
      { authInfo: botAuth },
    );
    expect(approval.isError).not.toBe(true);
    const request = JSON.parse(approval.content[0]!.text);
    expect(request).toMatchObject({
      kind: "approval",
      status: "open",
      conversationId: f.dmId,
      details: { command: "make deploy" },
      response: { choices: ["approve", "deny"] },
    });

    const [waited] = await Promise.all([
      tools.get("get_request")!({ requestId: request.id, waitSeconds: 20 }, { authInfo: botAuth }),
      (async () => {
        await sleep(500);
        await req("POST", `/bot-requests/${request.id}/answer`, { choice: "approve" }, f.owner.token);
      })(),
    ]);
    expect(JSON.parse(waited.content[0]!.text)).toMatchObject({
      status: "answered",
      answer: { choice: "approve" },
    });

    const question = await tools.get("ask_question")!(
      { question: "Which region?", choices: ["EU", "US"], waitSeconds: 0 },
      { authInfo: botAuth },
    );
    expect(JSON.parse(question.content[0]!.text)).toMatchObject({
      kind: "question",
      response: { type: "choice", choices: ["EU", "US"] },
    });

    const rows = await db
      .select({ id: botRequests.id })
      .from(botRequests)
      .where(and(eq(botRequests.botId, f.bot.id)));
    expect(rows).toHaveLength(2);
  });
});
