import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { authRoutes } from "../auth";
import { conversationRoutes } from "../conversations";
import { db } from "../db";
import { users, workspaces } from "../db/schema";
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
  const email = `reaction-${crypto.randomUUID()}@test.com`;
  createdUserEmails.push(email);
  const response = await req("POST", "/auth/register", {
    name,
    email,
    password: "password123",
  });
  expect(response.status).toBe(200);
  return { token: response.body.accessToken as string, user: response.body.user };
}

async function createSharedChannel() {
  const alice = await registerUser("Alice");
  const bob = await registerUser("Bob");
  const workspace = await req(
    "POST",
    "/workspaces/create",
    { name: "Reaction Test" },
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
    (await req(
      "POST",
      "/invites/accept",
      { inviteId: invite.body.id },
      bob.token,
    )).status,
  ).toBe(200);
  const details = await req(
    "GET",
    `/workspaces/${workspace.body.id}`,
    undefined,
    alice.token,
  );
  return {
    alice,
    bob,
    channelId: details.body.channels.find((channel: any) => channel.name === "general").id,
  };
}

describe("Message reactions", () => {
  test("persists an emoji reaction with viewer-specific state", async () => {
    const { alice, bob, channelId } = await createSharedChannel();
    const sent = await req(
      "POST",
      `/messages/${channelId}`,
      { content: "Ship it" },
      alice.token,
    );
    expect(sent.status).toBe(200);

    const reacted = await req(
      "POST",
      `/messages/${channelId}/${sent.body.id}/reactions`,
      { emoji: "👍", active: true },
      bob.token,
    );

    expect(reacted.status).toBe(200);
    expect(reacted.body.reactions).toEqual([
      { emoji: "👍", count: 1, reactedByMe: true, userNames: ["Bob"] },
    ]);

    const aliceMessages = await req(
      "GET",
      `/messages/${channelId}`,
      undefined,
      alice.token,
    );
    const bobMessages = await req(
      "GET",
      `/messages/${channelId}`,
      undefined,
      bob.token,
    );
    expect(aliceMessages.body[0].reactions).toEqual([
      { emoji: "👍", count: 1, reactedByMe: false, userNames: ["Bob"] },
    ]);
    expect(bobMessages.body[0].reactions).toEqual([
      { emoji: "👍", count: 1, reactedByMe: true, userNames: ["Bob"] },
    ]);
  });

  test("preserves reactions in idempotent message replay responses", async () => {
    const { alice, bob, channelId } = await createSharedChannel();
    const clientMessageId = crypto.randomUUID();
    const body = { content: "Replay with reactions", clientMessageId };
    const sent = await req("POST", `/messages/${channelId}`, body, alice.token);
    expect(sent.status).toBe(200);

    const reacted = await req(
      "POST",
      `/messages/${channelId}/${sent.body.id}/reactions`,
      { emoji: "👍", active: true },
      bob.token,
    );
    expect(reacted.status).toBe(200);

    const replay = await req("POST", `/messages/${channelId}`, body, alice.token);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(sent.body.id);
    expect(replay.body.reactions).toEqual([
      { emoji: "👍", count: 1, reactedByMe: false, userNames: ["Bob"] },
    ]);
  });

  test("broadcasts reaction changes to every conversation participant", async () => {
    const { alice, bob, channelId } = await createSharedChannel();
    const sent = await req(
      "POST",
      `/messages/${channelId}`,
      { content: "Realtime reaction" },
      alice.token,
    );
    realtimeEvents.length = 0;

    const reacted = await req(
      "POST",
      `/messages/${channelId}/${sent.body.id}/reactions`,
      { emoji: "🎉", active: true },
      bob.token,
    );

    expect(reacted.status).toBe(200);
    const event = realtimeEvents.find(
      (candidate) =>
        (candidate.event as { type: string }).type ===
        "message_reactions_updated",
    );
    expect(event).toBeDefined();
    expect(event?.targetUserIds.sort()).toEqual(
      [alice.user.id, bob.user.id].sort(),
    );
    expect(event?.event).toEqual({
      type: "message_reactions_updated",
      conversationId: channelId,
      messageId: sent.body.id,
    });
  });

  test("groups, deduplicates, and removes reactions", async () => {
    const { alice, bob, channelId } = await createSharedChannel();
    const sent = await req(
      "POST",
      `/messages/${channelId}`,
      { content: "Count reactions" },
      alice.token,
    );
    const reactionPath = `/messages/${channelId}/${sent.body.id}/reactions`;

    await req("POST", reactionPath, { emoji: "🔥", active: true }, alice.token);
    await req("POST", reactionPath, { emoji: "🔥", active: true }, bob.token);
    const duplicate = await req(
      "POST",
      reactionPath,
      { emoji: "🔥", active: true },
      bob.token,
    );
    expect(duplicate.body.reactions).toEqual([
      {
        emoji: "🔥",
        count: 2,
        reactedByMe: true,
        userNames: ["Alice", "Bob"],
      },
    ]);

    const removed = await req(
      "POST",
      reactionPath,
      { emoji: "🔥", active: false },
      bob.token,
    );
    expect(removed.body.reactions).toEqual([
      {
        emoji: "🔥",
        count: 1,
        reactedByMe: false,
        userNames: ["Alice"],
      },
    ]);
    const duplicateRemoval = await req(
      "POST",
      reactionPath,
      { emoji: "🔥", active: false },
      bob.token,
    );
    expect(duplicateRemoval.body.reactions).toEqual(removed.body.reactions);
  });

  test("does not allow a non-participant to react", async () => {
    const { alice, channelId } = await createSharedChannel();
    const outsider = await registerUser("Outsider");
    const sent = await req(
      "POST",
      `/messages/${channelId}`,
      { content: "Private conversation" },
      alice.token,
    );

    const reacted = await req(
      "POST",
      `/messages/${channelId}/${sent.body.id}/reactions`,
      { emoji: "👍", active: true },
      outsider.token,
    );
    const guessedMissingMessage = await req(
      "POST",
      `/messages/${channelId}/${crypto.randomUUID()}/reactions`,
      { emoji: "👍", active: true },
      outsider.token,
    );
    const participantMissingMessage = await req(
      "POST",
      `/messages/${channelId}/${crypto.randomUUID()}/reactions`,
      { emoji: "👍", active: true },
      alice.token,
    );

    expect(reacted.status).toBe(403);
    expect(guessedMissingMessage.status).toBe(403);
    expect(participantMissingMessage.status).toBe(404);
  });

  test(
    "bounds reaction cardinality while preserving idempotent adds",
    async () => {
      const { alice, bob, channelId } = await createSharedChannel();
      const sent = await req(
        "POST",
        `/messages/${channelId}`,
        { content: "Bounded reactions" },
        alice.token,
      );
      const reactionPath = `/messages/${channelId}/${sent.body.id}/reactions`;
      const emojis = [
        "👍",
        "❤️",
        "😂",
        "🎉",
        "😮",
        "😢",
        "🙏",
        "🔥",
        "😀",
        "😁",
        "😆",
        "😅",
        "🤣",
        "😊",
        "🙂",
        "🙃",
        "😉",
        "😍",
        "🥰",
        "😘",
        "😎",
      ];

      for (const emoji of emojis.slice(0, 20)) {
        const response = await req(
          "POST",
          reactionPath,
          { emoji, active: true },
          alice.token,
        );
        expect(response.status).toBe(200);
      }

      const duplicate = await req(
        "POST",
        reactionPath,
        { emoji: emojis[0], active: true },
        alice.token,
      );
      const joinedExisting = await req(
        "POST",
        reactionPath,
        { emoji: emojis[0], active: true },
        bob.token,
      );
      const perUserOverflow = await req(
        "POST",
        reactionPath,
        { emoji: emojis[20], active: true },
        alice.token,
      );
      const perMessageOverflow = await req(
        "POST",
        reactionPath,
        { emoji: emojis[20], active: true },
        bob.token,
      );

      expect(duplicate.status).toBe(200);
      expect(joinedExisting.status).toBe(200);
      expect(
        joinedExisting.body.reactions.find(
          (reaction: { emoji: string }) => reaction.emoji === emojis[0],
        ),
      ).toMatchObject({ count: 2, reactedByMe: true });
      expect(perUserOverflow.status).toBe(400);
      expect(perMessageOverflow.status).toBe(400);
    },
    30_000,
  );

  test("accepts complete emoji sequences and rejects malformed graphemes", async () => {
    const { alice, bob, channelId } = await createSharedChannel();
    const sent = await req(
      "POST",
      `/messages/${channelId}`,
      { content: "Emoji only" },
      alice.token,
    );
    const reactionPath = `/messages/${channelId}/${sent.body.id}/reactions`;

    for (const emoji of [
      "not-an-emoji",
      "👍👍",
      "👍\u0301",
      "\u20e3",
      "🇦",
      "🚗🏽",
      "🍎🏿",
    ]) {
      const reacted = await req(
        "POST",
        reactionPath,
        { emoji, active: true },
        bob.token,
      );
      expect(reacted.status).toBe(400);
      expect(reacted.body.error).toBe("Reaction must be a single emoji");
    }

    for (const emoji of ["1️⃣", "🇨🇭", "👨‍👩‍👧‍👦", "👩🏽‍💻"]) {
      const reacted = await req(
        "POST",
        reactionPath,
        { emoji, active: true },
        bob.token,
      );
      expect(reacted.status).toBe(200);
    }
  });
});
