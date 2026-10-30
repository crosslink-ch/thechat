import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { authRoutes } from "../auth";
import { conversationRoutes } from "../conversations";
import { db } from "../db";
import { messages, users, workspaces } from "../db/schema";
import { inviteRoutes } from "../invites";
import { messageRoutes } from "../messages";
import {
  closeRealtimeBusForTests,
  LocalRealtimeBus,
  setRealtimeBusForTests,
  type RealtimeEvent,
} from "../realtime";
import { workspaceRoutes } from "../workspaces";

const app = new Elysia()
  .use(authRoutes)
  .use(workspaceRoutes)
  .use(inviteRoutes)
  .use(conversationRoutes)
  .use(messageRoutes);

const createdUserEmails: string[] = [];
const createdWorkspaceIds: string[] = [];
const realtimeEvents: RealtimeEvent[] = [];
let unsubscribeRealtime: (() => Promise<void>) | null = null;

beforeAll(async () => {
  const realtimeBus = new LocalRealtimeBus();
  await setRealtimeBusForTests(realtimeBus);
  unsubscribeRealtime = await realtimeBus.subscribe((event) => {
    realtimeEvents.push(event);
  });
});

afterAll(async () => {
  for (const id of createdWorkspaceIds) {
    await db.delete(workspaces).where(eq(workspaces.id, id));
  }
  for (const email of createdUserEmails) {
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (user) await db.delete(users).where(eq(users.id, user.id));
  }
  await unsubscribeRealtime?.();
  await closeRealtimeBusForTests();
});

async function req(
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
  let responseBody: any;
  try {
    responseBody = JSON.parse(text);
  } catch {
    responseBody = text;
  }
  return { status: response.status, body: responseBody };
}

async function registerUser(name: string) {
  const email = `quote-${crypto.randomUUID()}@test.com`;
  createdUserEmails.push(email);
  const response = await req("POST", "/auth/register", {
    name,
    email,
    password: "password123",
  });
  expect(response.status).toBe(200);
  return { token: response.body.accessToken as string, user: response.body.user };
}

/** Alice and Bob share a workspace (general channel + DM); Carol is outside. */
async function createWorkspace() {
  const alice = await registerUser("Alice");
  const bob = await registerUser("Bob");
  const workspace = await req(
    "POST",
    "/workspaces/create",
    { name: "Quote Test" },
    alice.token,
  );
  expect(workspace.status).toBe(200);
  createdWorkspaceIds.push(workspace.body.id);
  const invite = await req(
    "POST",
    "/invites/create",
    { workspaceId: workspace.body.id, email: bob.user.email },
    alice.token,
  );
  expect(invite.status).toBe(200);
  expect(
    (await req("POST", "/invites/accept", { inviteId: invite.body.id }, bob.token))
      .status,
  ).toBe(200);
  const details = await req(
    "GET",
    `/workspaces/${workspace.body.id}`,
    undefined,
    alice.token,
  );
  const dm = await req(
    "POST",
    "/conversations/dm",
    { workspaceId: workspace.body.id, otherUserId: bob.user.id },
    alice.token,
  );
  expect(dm.status).toBe(200);
  return {
    alice,
    bob,
    channelId: details.body.channels.find((c: any) => c.name === "general").id as string,
    dmId: dm.body.id as string,
  };
}

const SOURCE =
  "Direction matters. A rule like group:eng → tag:vm:22 lets users start connections to the VM.";

describe("Message quotes", () => {
  test("a reply carries the quoted snippet to every reader and realtime recipient", async () => {
    const { alice, bob, channelId } = await createWorkspace();
    const source = await req("POST", `/messages/${channelId}`, { content: SOURCE }, alice.token);
    expect(source.status).toBe(200);
    expect(source.body.quote).toBeNull();

    const quoteText = "A rule like group:eng → tag:vm:22 lets users start connections";
    const reply = await req(
      "POST",
      `/messages/${channelId}`,
      {
        content: "How does the return traffic get through?",
        quote: { text: quoteText, messageId: source.body.id },
      },
      bob.token,
    );
    expect(reply.status).toBe(200);
    expect(reply.body.quote).toEqual({ text: quoteText, messageId: source.body.id });

    const history = await req("GET", `/messages/${channelId}`, undefined, alice.token);
    const persisted = history.body.find((m: any) => m.id === reply.body.id);
    expect(persisted.quote).toEqual({ text: quoteText, messageId: source.body.id });

    const delivered = realtimeEvents.find(
      (event) =>
        event.event.type === "new_message" &&
        event.event.message.id === reply.body.id,
    );
    expect(delivered?.targetUserIds.sort()).toEqual(
      [alice.user.id, bob.user.id].sort(),
    );
    expect((delivered?.event as any).message.quote).toEqual({
      text: quoteText,
      messageId: source.body.id,
    });
  });

  test("a quote-only reply still needs message text", async () => {
    const { alice, channelId } = await createWorkspace();
    const source = await req("POST", `/messages/${channelId}`, { content: SOURCE }, alice.token);
    const reply = await req(
      "POST",
      `/messages/${channelId}`,
      { content: "   ", quote: { text: "Direction matters.", messageId: source.body.id } },
      alice.token,
    );
    expect(reply.status).toBe(400);
  });

  test("normalizes copied selections and rejects text that is empty after cleanup", async () => {
    const { alice, channelId } = await createWorkspace();
    const source = await req("POST", `/messages/${channelId}`, { content: SOURCE }, alice.token);
    const reply = await req(
      "POST",
      `/messages/${channelId}`,
      {
        content: "Normalized",
        quote: {
          text: "  First line \r\n\r\n\r\n\r\nSecond\u0007 line\t\r\n ",
          messageId: source.body.id,
        },
      },
      alice.token,
    );
    expect(reply.status).toBe(200);
    expect(reply.body.quote.text).toBe("First line\n\nSecond line");

    const blank = await req(
      "POST",
      `/messages/${channelId}`,
      { content: "Blank quote", quote: { text: " \u0000\r\n ", messageId: source.body.id } },
      alice.token,
    );
    expect(blank.status).toBe(400);
  });

  test("rejects quotes of messages from another conversation, unknown ids, and oversized text", async () => {
    const { alice, channelId, dmId } = await createWorkspace();
    const privateSource = await req("POST", `/messages/${dmId}`, { content: "DM only" }, alice.token);
    expect(privateSource.status).toBe(200);

    const crossConversation = await req(
      "POST",
      `/messages/${channelId}`,
      { content: "Leak?", quote: { text: "DM only", messageId: privateSource.body.id } },
      alice.token,
    );
    const unknown = await req(
      "POST",
      `/messages/${channelId}`,
      { content: "Ghost", quote: { text: "nothing", messageId: crypto.randomUUID() } },
      alice.token,
    );
    // Same status and message for both: a sender cannot probe message ids.
    expect(crossConversation.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(crossConversation.body).toEqual(unknown.body);

    const source = await req("POST", `/messages/${channelId}`, { content: SOURCE }, alice.token);
    const oversized = await req(
      "POST",
      `/messages/${channelId}`,
      { content: "Too long", quote: { text: "x".repeat(4_001), messageId: source.body.id } },
      alice.token,
    );
    expect(oversized.status).toBe(400);

    const history = await req("GET", `/messages/${channelId}`, undefined, alice.token);
    expect(history.body.map((m: any) => m.content)).toEqual([SOURCE]);
  });

  test("an idempotent retry must repeat the same quote", async () => {
    const { alice, channelId } = await createWorkspace();
    const source = await req("POST", `/messages/${channelId}`, { content: SOURCE }, alice.token);
    const body = {
      clientMessageId: crypto.randomUUID(),
      content: "Retry me",
      quote: { text: "Direction matters.", messageId: source.body.id },
    };
    const first = await req("POST", `/messages/${channelId}`, body, alice.token);
    const replay = await req("POST", `/messages/${channelId}`, body, alice.token);
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.quote).toEqual(first.body.quote);

    const changedQuote = await req(
      "POST",
      `/messages/${channelId}`,
      { ...body, quote: { ...body.quote, text: "Direction" } },
      alice.token,
    );
    const droppedQuote = await req(
      "POST",
      `/messages/${channelId}`,
      { ...body, quote: null },
      alice.token,
    );
    expect(changedQuote.status).toBe(409);
    expect(droppedQuote.status).toBe(409);
  });

  test("deleting the quoted message keeps the snippet and clears its source", async () => {
    const { alice, bob, channelId } = await createWorkspace();
    const source = await req("POST", `/messages/${channelId}`, { content: SOURCE }, alice.token);
    const body = {
      clientMessageId: crypto.randomUUID(),
      content: "Keep this context",
      quote: { text: "Direction matters.", messageId: source.body.id },
    };
    const reply = await req("POST", `/messages/${channelId}`, body, bob.token);
    expect(reply.status).toBe(200);

    await db.delete(messages).where(eq(messages.id, source.body.id));

    const history = await req("GET", `/messages/${channelId}`, undefined, bob.token);
    expect(history.body.find((m: any) => m.id === reply.body.id).quote).toEqual({
      text: "Direction matters.",
      messageId: null,
    });

    // A retry of the original send is still the same command after the delete.
    const replay = await req("POST", `/messages/${channelId}`, body, bob.token);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(reply.body.id);
  });
});
