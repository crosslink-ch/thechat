import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { Elysia } from "elysia";
import { asc, eq } from "drizzle-orm";
import { db } from "../db";
import {
  botInvocations,
  bots,
  conversationParticipants,
  users,
  workspaces,
} from "../db/schema";
import { authRoutes } from "../auth";
import { workspaceRoutes } from "../workspaces";
import { conversationRoutes } from "../conversations";
import { messageRoutes } from "../messages";
import { botRuntimeRoutes } from "../bot-runtime";
import { hermesPlatformRoutes } from "../hermes-platform";
import { botRoutes } from "./index";
import { closeBotRuntimeForTests, startBotWorker } from "../services/bot-runtime";
import {
  closeBotProgressStoreForTests,
  createLocalBotProgressStoreForTests,
  setBotProgressStoreForTests,
} from "../services/bot-progress-store";
import {
  closeRealtimeBusForTests,
  RedisRealtimeBus,
  setRealtimeBusForTests,
  type RealtimeEvent,
} from "../realtime";
import crypto from "crypto";

const app = new Elysia()
  .use(authRoutes)
  .use(workspaceRoutes)
  .use(conversationRoutes)
  .use(messageRoutes)
  .use(botRuntimeRoutes)
  .use(hermesPlatformRoutes)
  .use(botRoutes);

function uniqueEmail() {
  return `test-${crypto.randomUUID()}@test.com`;
}

const createdUserEmails: string[] = [];
const createdWorkspaceIds: string[] = [];
const createdBotUserIds: string[] = [];

beforeAll(async () => {
  await setBotProgressStoreForTests(createLocalBotProgressStoreForTests());
});

afterAll(async () => {
  await closeBotRuntimeForTests();
  await closeBotProgressStoreForTests();
  await closeRealtimeBusForTests();
  // Clean up bots (cascade from user delete handles bot records)
  for (const id of createdBotUserIds) {
    await db.delete(users).where(eq(users.id, id));
  }
  for (const id of createdWorkspaceIds) {
    await db.delete(workspaces).where(eq(workspaces.id, id));
  }
  for (const email of createdUserEmails) {
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (user) {
      await db.delete(users).where(eq(users.id, user.id));
    }
  }
});

async function req(
  method: string,
  path: string,
  body?: unknown,
  token?: string
) {
  const headers: Record<string, string> = {};
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })
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
  const email = uniqueEmail();
  createdUserEmails.push(email);

  const res = await req("POST", "/auth/register", {
    name,
    email,
    password: "password123",
  });

  return { token: res.body.accessToken as string, user: res.body.user };
}

async function createBot(
  ownerToken: string,
  name: string,
  webhookUrl?: string,
  extra?: Record<string, unknown>,
) {
  const res = await req(
    "POST",
    "/bots/create",
    { name, webhookUrl, ...extra },
    ownerToken
  );
  if (res.body.userId) {
    createdBotUserIds.push(res.body.userId);
  }
  return res;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForResult<T>(
  getter: () => Promise<T | null | undefined>,
  label: string,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | null | undefined;
  while (Date.now() < deadline) {
    lastValue = await getter();
    if (lastValue) return lastValue;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(lastValue)}`);
}

async function invocationsForMessage(messageId: string) {
  return db
    .select({
      id: botInvocations.id,
      botId: botInvocations.botId,
      status: botInvocations.status,
      error: botInvocations.error,
      responseMessageId: botInvocations.responseMessageId,
    })
    .from(botInvocations)
    .where(eq(botInvocations.triggerMessageId, messageId))
    .orderBy(asc(botInvocations.createdAt));
}

async function startBotWorkerForTest() {
  await startBotWorker({ concurrency: 1 });
}

function startWebhookServer(
  handler: (request: Request, body: string) => Response | Promise<Response> = () => new Response("ok"),
) {
  const requests: Array<{ body: string; payload: any }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.text();
      requests.push({ body, payload: JSON.parse(body) });
      return handler(request, body);
    },
  });
  return {
    requests,
    url: `http://localhost:${server.port}/webhook`,
    stop: () => server.stop(),
  };
}

async function createWorkspaceWithGeneralChannel(token: string, name: string) {
  const wsRes = await req("POST", "/workspaces/create", { name }, token);
  expect(wsRes.status).toBe(200);
  createdWorkspaceIds.push(wsRes.body.id);

  const detailRes = await req("GET", `/workspaces/${wsRes.body.id}`, undefined, token);
  expect(detailRes.status).toBe(200);
  return {
    workspaceId: wsRes.body.id as string,
    channelId: detailRes.body.channels[0].id as string,
  };
}

async function addBotToWorkspace(botId: string, workspaceId: string, token: string) {
  const res = await req("POST", `/bots/${botId}/workspaces`, { workspaceId }, token);
  expect(res.status).toBe(200);
}

describe("Bots: Create", () => {
  test("human creates bot, verify name + apiKey + webhookSecret returned", async () => {
    const human = await registerUser("BotOwner");

    const res = await createBot(human.token, "MyBot");

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("MyBot");
    expect(res.body.apiKey).toBeDefined();
    expect(res.body.apiKey).toStartWith("bot_");
    expect(res.body.webhookSecret).toBeDefined();
    expect(res.body.webhookSecret).toStartWith("whsec_");
    expect(res.body.id).toBeDefined();
    expect(res.body.userId).toBeDefined();
  });

  test("only humans can create bots — bot tries to create bot → 403", async () => {
    const human = await registerUser("Human");

    const botRes = await createBot(human.token, "FirstBot");
    const botApiKey = botRes.body.apiKey;

    // Now use bot's API key to try creating another bot
    const res = await createBot(botApiKey, "SecondBot");

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Bots cannot create other bots");
  });

  test("rejects unauthenticated request", async () => {
    const res = await req("POST", "/bots/create", { name: "NoAuth" });
    expect(res.status).toBe(401);
  });
});

describe("Bots: Authentication", () => {
  test("bot authenticates with apiKey as Bearer token", async () => {
    const human = await registerUser("AuthOwner");
    const botRes = await createBot(human.token, "AuthBot");

    // Use bot's API key to access an auth-required endpoint
    const meRes = await req("GET", "/auth/me", undefined, botRes.body.apiKey);

    expect(meRes.status).toBe(200);
    expect(meRes.body.user.id).toBe(botRes.body.userId);
    expect(meRes.body.user.name).toBe("AuthBot");
  });
});

describe("Bots: Workspace management", () => {
  test("add bot to workspace — bot appears in members + channel participants", async () => {
    const human = await registerUser("WSOwner");

    // Create workspace
    const wsRes = await req(
      "POST",
      "/workspaces/create",
      { name: "Bot Workspace" },
      human.token
    );
    createdWorkspaceIds.push(wsRes.body.id);

    // Create bot
    const botRes = await createBot(human.token, "WSBot");

    // Add bot to workspace
    const addRes = await req(
      "POST",
      `/bots/${botRes.body.id}/workspaces`,
      { workspaceId: wsRes.body.id },
      human.token
    );
    expect(addRes.status).toBe(200);
    expect(addRes.body.success).toBe(true);

    // Verify bot is in workspace members
    const detailRes = await req(
      "GET",
      `/workspaces/${wsRes.body.id}`,
      undefined,
      human.token
    );
    const botMember = detailRes.body.members.find(
      (m: any) => m.userId === botRes.body.userId
    );
    expect(botMember).toBeDefined();
  });

  test("non-member user cannot add bot to workspace → 403", async () => {
    const owner = await registerUser("WSOwnr");
    const stranger = await registerUser("Stranger");

    const wsRes = await req(
      "POST",
      "/workspaces/create",
      { name: "Private WS" },
      owner.token
    );
    createdWorkspaceIds.push(wsRes.body.id);

    const botRes = await createBot(owner.token, "PrivBot");

    // Stranger tries to add bot
    const addRes = await req(
      "POST",
      `/bots/${botRes.body.id}/workspaces`,
      { workspaceId: wsRes.body.id },
      stranger.token
    );
    expect(addRes.status).toBe(403);
  });

  test("remove bot from workspace — removed from members + channels", async () => {
    const human = await registerUser("RemOwner");

    const wsRes = await req(
      "POST",
      "/workspaces/create",
      { name: "Remove Bot WS" },
      human.token
    );
    createdWorkspaceIds.push(wsRes.body.id);

    const botRes = await createBot(human.token, "RemBot");

    // Add bot
    await req(
      "POST",
      `/bots/${botRes.body.id}/workspaces`,
      { workspaceId: wsRes.body.id },
      human.token
    );

    // Remove bot
    const removeRes = await req(
      "DELETE",
      `/bots/${botRes.body.id}/workspaces/${wsRes.body.id}`,
      undefined,
      human.token
    );
    expect(removeRes.status).toBe(200);

    // Verify bot is no longer in workspace members
    const detailRes = await req(
      "GET",
      `/workspaces/${wsRes.body.id}`,
      undefined,
      human.token
    );
    const botMember = detailRes.body.members.find(
      (m: any) => m.userId === botRes.body.userId
    );
    expect(botMember).toBeUndefined();
  });
});

describe("Bots: Send messages", () => {
  test("bot sends message to a channel", async () => {
    const human = await registerUser("MsgOwner");

    const wsRes = await req(
      "POST",
      "/workspaces/create",
      { name: "Msg Bot WS" },
      human.token
    );
    createdWorkspaceIds.push(wsRes.body.id);

    const botRes = await createBot(human.token, "MsgBot");

    // Add bot to workspace
    await req(
      "POST",
      `/bots/${botRes.body.id}/workspaces`,
      { workspaceId: wsRes.body.id },
      human.token
    );

    // Get the general channel
    const detailRes = await req(
      "GET",
      `/workspaces/${wsRes.body.id}`,
      undefined,
      human.token
    );
    const channelId = detailRes.body.channels[0].id;

    // Bot sends a message
    const sendRes = await req(
      "POST",
      `/messages/${channelId}`,
      { content: "Hello from bot!" },
      botRes.body.apiKey
    );

    expect(sendRes.status).toBe(200);
    expect(sendRes.body.content).toBe("Hello from bot!");
    expect(sendRes.body.senderId).toBe(botRes.body.userId);
    expect(sendRes.body.senderName).toBe("MsgBot");
  });
});

describe("Bots: List", () => {
  test("lists bots owned by current user", async () => {
    const human = await registerUser("ListOwner");

    await createBot(human.token, "ListBot1");
    await createBot(human.token, "ListBot2");

    const res = await req("GET", "/bots/list", undefined, human.token);

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
    const names = res.body.map((b: any) => b.name);
    expect(names).toContain("ListBot1");
    expect(names).toContain("ListBot2");
  });
});

describe("Bots: Regenerate key", () => {
  test("new key works, old key fails", async () => {
    const human = await registerUser("RegenOwner");

    const botRes = await createBot(human.token, "RegenBot");
    const oldKey = botRes.body.apiKey;

    // Verify old key works
    const meRes1 = await req("GET", "/auth/me", undefined, oldKey);
    expect(meRes1.status).toBe(200);

    // Regenerate
    const regenRes = await req(
      "POST",
      `/bots/${botRes.body.id}/regenerate-key`,
      {},
      human.token
    );
    expect(regenRes.status).toBe(200);
    expect(regenRes.body.apiKey).toBeDefined();
    expect(regenRes.body.apiKey).not.toBe(oldKey);

    const newKey = regenRes.body.apiKey;

    // New key works
    const meRes2 = await req("GET", "/auth/me", undefined, newKey);
    expect(meRes2.status).toBe(200);
    expect(meRes2.body.user.name).toBe("RegenBot");

    // Old key fails
    const meRes3 = await req("GET", "/auth/me", undefined, oldKey);
    expect(meRes3.status).toBe(401);
  });
});

describe("Bots: DM with bot", () => {
  test("create DM with bot, bot can read messages", async () => {
    const human = await registerUser("DMOwner");

    const wsRes = await req(
      "POST",
      "/workspaces/create",
      { name: "DM Bot WS" },
      human.token
    );
    createdWorkspaceIds.push(wsRes.body.id);

    const botRes = await createBot(human.token, "DMBot");

    // Add bot to workspace
    await req(
      "POST",
      `/bots/${botRes.body.id}/workspaces`,
      { workspaceId: wsRes.body.id },
      human.token
    );

    // Create DM with bot
    const dmRes = await req(
      "POST",
      "/conversations/dm",
      { workspaceId: wsRes.body.id, otherUserId: botRes.body.userId },
      human.token
    );
    expect(dmRes.status).toBe(200);
    const dmId = dmRes.body.id;

    // Human sends message
    const sendRes = await req(
      "POST",
      `/messages/${dmId}`,
      { content: "Hey bot!" },
      human.token
    );
    expect(sendRes.status).toBe(200);

    // Bot reads messages
    const fetchRes = await req(
      "GET",
      `/messages/${dmId}`,
      undefined,
      botRes.body.apiKey
    );
    expect(fetchRes.status).toBe(200);
    expect(fetchRes.body.length).toBeGreaterThanOrEqual(1);
    expect(fetchRes.body[0].content).toBe("Hey bot!");
  });

  test("adding another bot does not attach it to an existing bot DM", async () => {
    const human = await registerUser("MultiBotDMOwner");

    const wsRes = await req(
      "POST",
      "/workspaces/create",
      { name: "Multi Bot DM WS" },
      human.token
    );
    createdWorkspaceIds.push(wsRes.body.id);

    const firstBotRes = await createBot(human.token, "FirstDMBot");
    await req(
      "POST",
      `/bots/${firstBotRes.body.id}/workspaces`,
      { workspaceId: wsRes.body.id },
      human.token
    );

    const firstDmRes = await req(
      "POST",
      "/conversations/dm",
      { workspaceId: wsRes.body.id, otherUserId: firstBotRes.body.userId },
      human.token
    );
    expect(firstDmRes.status).toBe(200);

    const secondBotRes = await createBot(human.token, "SecondDMBot");
    await req(
      "POST",
      `/bots/${secondBotRes.body.id}/workspaces`,
      { workspaceId: wsRes.body.id },
      human.token
    );

    const firstDmParticipants = await db
      .select({ userId: conversationParticipants.userId })
      .from(conversationParticipants)
      .where(eq(conversationParticipants.conversationId, firstDmRes.body.id));
    expect(firstDmParticipants.map((p) => p.userId).sort()).toEqual(
      [human.user.id, firstBotRes.body.userId].sort()
    );

    const secondDmRes = await req(
      "POST",
      "/conversations/dm",
      { workspaceId: wsRes.body.id, otherUserId: secondBotRes.body.userId },
      human.token
    );
    expect(secondDmRes.status).toBe(200);
    expect(secondDmRes.body.id).not.toBe(firstDmRes.body.id);
  });

  test("corrupted DMs with extra participants are not reused for a different bot", async () => {
    const human = await registerUser("CorruptDMOwner");

    const wsRes = await req(
      "POST",
      "/workspaces/create",
      { name: "Corrupt Bot DM WS" },
      human.token
    );
    createdWorkspaceIds.push(wsRes.body.id);

    const firstBotRes = await createBot(human.token, "CorruptFirstBot");
    const secondBotRes = await createBot(human.token, "CorruptSecondBot");
    await req(
      "POST",
      `/bots/${firstBotRes.body.id}/workspaces`,
      { workspaceId: wsRes.body.id },
      human.token
    );
    await req(
      "POST",
      `/bots/${secondBotRes.body.id}/workspaces`,
      { workspaceId: wsRes.body.id },
      human.token
    );

    const firstDmRes = await req(
      "POST",
      "/conversations/dm",
      { workspaceId: wsRes.body.id, otherUserId: firstBotRes.body.userId },
      human.token
    );
    expect(firstDmRes.status).toBe(200);

    await db
      .insert(conversationParticipants)
      .values({
        conversationId: firstDmRes.body.id,
        userId: secondBotRes.body.userId,
        role: "member",
      })
      .onConflictDoNothing();

    const firstDmAgainRes = await req(
      "POST",
      "/conversations/dm",
      { workspaceId: wsRes.body.id, otherUserId: firstBotRes.body.userId },
      human.token
    );
    expect(firstDmAgainRes.status).toBe(200);
    expect(firstDmAgainRes.body.id).toBe(firstDmRes.body.id);

    const repairedFirstParticipants = await db
      .select({ userId: conversationParticipants.userId })
      .from(conversationParticipants)
      .where(eq(conversationParticipants.conversationId, firstDmRes.body.id));
    expect(repairedFirstParticipants.map((p) => p.userId).sort()).toEqual(
      [human.user.id, firstBotRes.body.userId].sort()
    );

    const secondDmRes = await req(
      "POST",
      "/conversations/dm",
      { workspaceId: wsRes.body.id, otherUserId: secondBotRes.body.userId },
      human.token
    );

    expect(secondDmRes.status).toBe(200);
    expect(secondDmRes.body.id).not.toBe(firstDmRes.body.id);

    const secondDmParticipants = await db
      .select({ userId: conversationParticipants.userId })
      .from(conversationParticipants)
      .where(eq(conversationParticipants.conversationId, secondDmRes.body.id));
    expect(secondDmParticipants.map((p) => p.userId).sort()).toEqual(
      [human.user.id, secondBotRes.body.userId].sort()
    );

  });

  test("Hermes DM sessions isolate message history", async () => {
    const human = await registerUser("HermesSessionOwner");

    const wsRes = await req(
      "POST",
      "/workspaces/create",
      { name: "Hermes Sessions WS" },
      human.token
    );
    createdWorkspaceIds.push(wsRes.body.id);

    const botRes = await createBot(human.token, "HermesSessions", undefined, {
      kind: "hermes",
      workspaceId: wsRes.body.id,
    });
    expect(botRes.status).toBe(200);

    const dmRes = await req(
      "POST",
      "/conversations/dm",
      { workspaceId: wsRes.body.id, otherUserId: botRes.body.userId },
      human.token
    );
    expect(dmRes.status).toBe(200);
    const dmId = dmRes.body.id;

    const firstSend = await req(
      "POST",
      `/messages/${dmId}`,
      { content: "first session message" },
      human.token
    );
    expect(firstSend.status).toBe(200);
    const defaultSessionId = firstSend.body.botSessionId;
    expect(defaultSessionId).toBeDefined();

    const newSession = await req(
      "POST",
      `/bot-runtime/conversations/${dmId}/sessions`,
      {},
      human.token
    );
    expect(newSession.status).toBe(200);
    expect(newSession.body.id).not.toBe(defaultSessionId);

    const secondSend = await req(
      "POST",
      `/messages/${dmId}`,
      { content: "second session message", botSessionId: newSession.body.id },
      human.token
    );
    expect(secondSend.status).toBe(200);
    expect(secondSend.body.botSessionId).toBe(newSession.body.id);

    const defaultHistory = await req(
      "GET",
      `/messages/${dmId}?botSessionId=${defaultSessionId}`,
      undefined,
      human.token
    );
    expect(defaultHistory.status).toBe(200);
    expect(defaultHistory.body.map((m: any) => m.content)).toEqual([
      "first session message",
    ]);

    const newHistory = await req(
      "GET",
      `/messages/${dmId}?botSessionId=${newSession.body.id}`,
      undefined,
      human.token
    );
    expect(newHistory.status).toBe(200);
    expect(newHistory.body.map((m: any) => m.content)).toEqual([
      "second session message",
    ]);
  });
});

describe("Bots: Get bot", () => {
  test("owner can get bot details", async () => {
    const human = await registerUser("GetOwner");

    const botRes = await createBot(human.token, "GetBot", "https://example.com/hook");

    const res = await req("GET", `/bots/${botRes.body.id}`, undefined, human.token);

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("GetBot");
    expect(res.body.webhookUrl).toBe("https://example.com/hook");
    expect(res.body.webhookSecret).toBeDefined();
    expect(res.body.id).toBe(botRes.body.id);
  });

  test("non-owner cannot get bot details → 403", async () => {
    const owner = await registerUser("GetBotOwner");
    const stranger = await registerUser("GetStranger");

    const botRes = await createBot(owner.token, "SecretBot");

    const res = await req("GET", `/bots/${botRes.body.id}`, undefined, stranger.token);

    expect(res.status).toBe(403);
  });

  test("non-existent bot → 404", async () => {
    const human = await registerUser("Get404");

    const res = await req(
      "GET",
      "/bots/00000000-0000-0000-0000-000000000000",
      undefined,
      human.token
    );

    expect(res.status).toBe(404);
  });
});

describe("Bots: Update bot", () => {
  test("owner can update bot name", async () => {
    const human = await registerUser("UpdOwner");

    const botRes = await createBot(human.token, "OldName");

    const res = await req(
      "PATCH",
      `/bots/${botRes.body.id}`,
      { name: "NewName" },
      human.token
    );

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("NewName");
  });

  test("owner can update webhook URL", async () => {
    const human = await registerUser("UpdHookOwner");

    const botRes = await createBot(human.token, "HookBot");

    const res = await req(
      "PATCH",
      `/bots/${botRes.body.id}`,
      { webhookUrl: "https://new-hook.example.com/webhook" },
      human.token
    );

    expect(res.status).toBe(200);
    expect(res.body.webhookUrl).toBe("https://new-hook.example.com/webhook");
  });

  test("owner can clear webhook URL by passing null", async () => {
    const human = await registerUser("ClearHookOwner");

    const botRes = await createBot(human.token, "ClearBot", "https://example.com/hook");

    const res = await req(
      "PATCH",
      `/bots/${botRes.body.id}`,
      { webhookUrl: null },
      human.token
    );

    expect(res.status).toBe(200);
    expect(res.body.webhookUrl).toBeNull();
  });

  test("owner can update both name and webhookUrl", async () => {
    const human = await registerUser("UpdBothOwner");

    const botRes = await createBot(human.token, "BothBot");

    const res = await req(
      "PATCH",
      `/bots/${botRes.body.id}`,
      { name: "UpdatedBoth", webhookUrl: "https://both.example.com/hook" },
      human.token
    );

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("UpdatedBoth");
    expect(res.body.webhookUrl).toBe("https://both.example.com/hook");
  });

  test("bot can register and clear its own webhook URL", async () => {
    const webhook = startWebhookServer();
    try {
      const human = await registerUser("BotWebhookRegistrationOwner");
      const { workspaceId, channelId } = await createWorkspaceWithGeneralChannel(
        human.token,
        "Bot Webhook Registration",
      );
      const botRes = await createBot(human.token, "RegisteringBot");
      expect(botRes.status).toBe(200);
      await addBotToWorkspace(botRes.body.id, workspaceId, human.token);

      const humanRegisterRes = await req(
        "POST",
        "/bots/me/webhook",
        { url: webhook.url },
        human.token,
      );
      expect(humanRegisterRes.status).toBe(403);

      const registerRes = await req(
        "POST",
        "/bots/me/webhook",
        { url: webhook.url },
        botRes.body.apiKey,
      );
      expect(registerRes.status).toBe(200);
      expect(registerRes.body.webhookUrl).toBe(webhook.url);

      await startBotWorkerForTest();
      const sendRes = await req(
        "POST",
        `/messages/${channelId}`,
        { content: "@RegisteringBot use your registered webhook" },
        human.token,
      );
      expect(sendRes.status).toBe(200);

      const delivery = await waitForResult(async () => {
        return webhook.requests.find((request) => request.payload.message?.id === sendRes.body.id);
      }, "registered bot webhook delivery");
      expect(delivery.payload.bot.id).toBe(botRes.body.id);

      const clearRes = await req("DELETE", "/bots/me/webhook", undefined, botRes.body.apiKey);
      expect(clearRes.status).toBe(200);
      expect(clearRes.body.webhookUrl).toBeNull();

      const detailRes = await req("GET", `/bots/${botRes.body.id}`, undefined, human.token);
      expect(detailRes.status).toBe(200);
      expect(detailRes.body.webhookUrl).toBeNull();
    } finally {
      webhook.stop();
    }
  });

  test("non-owner cannot update bot → 403", async () => {
    const owner = await registerUser("UpdBotOwner");
    const stranger = await registerUser("UpdStranger");

    const botRes = await createBot(owner.token, "NoUpdBot");

    const res = await req(
      "PATCH",
      `/bots/${botRes.body.id}`,
      { name: "Hacked" },
      stranger.token
    );

    expect(res.status).toBe(403);
  });
});

describe("Bots: Delete bot", () => {
  test("owner can delete bot — bot disappears from list + API key stops working", async () => {
    const human = await registerUser("DelOwner");

    const botRes = await createBot(human.token, "DelBot");
    const apiKey = botRes.body.apiKey;
    const botUserId = botRes.body.userId;

    // Verify bot works before deletion
    const meRes = await req("GET", "/auth/me", undefined, apiKey);
    expect(meRes.status).toBe(200);

    // Delete the bot
    const delRes = await req(
      "DELETE",
      `/bots/${botRes.body.id}`,
      undefined,
      human.token
    );
    expect(delRes.status).toBe(200);
    expect(delRes.body.success).toBe(true);

    // API key should no longer work
    const meRes2 = await req("GET", "/auth/me", undefined, apiKey);
    expect(meRes2.status).toBe(401);

    // Bot should not appear in list
    const listRes = await req("GET", "/bots/list", undefined, human.token);
    const ids = listRes.body.map((b: any) => b.id);
    expect(ids).not.toContain(botRes.body.id);

    // Remove from cleanup list since we already deleted it
    const idx = createdBotUserIds.indexOf(botUserId);
    if (idx !== -1) createdBotUserIds.splice(idx, 1);
  });

  test("non-owner cannot delete bot → 403", async () => {
    const owner = await registerUser("DelBotOwner");
    const stranger = await registerUser("DelStranger");

    const botRes = await createBot(owner.token, "NoDelBot");

    const res = await req(
      "DELETE",
      `/bots/${botRes.body.id}`,
      undefined,
      stranger.token
    );

    expect(res.status).toBe(403);
  });
});

describe("Bots: mention routing", () => {
  test("only invokes the explicitly mentioned bot when multiple bots share a channel", async () => {
    const webhook = startWebhookServer();
    try {
      const human = await registerUser("MentionOwner");
      const { workspaceId, channelId } = await createWorkspaceWithGeneralChannel(
        human.token,
        "Mention Routing WS",
      );

      const alpha = await createBot(human.token, "Alpha.Bot", webhook.url);
      const beta = await createBot(human.token, "BetaBot", webhook.url);
      await addBotToWorkspace(alpha.body.id, workspaceId, human.token);
      await addBotToWorkspace(beta.body.id, workspaceId, human.token);

      await startBotWorkerForTest();
      const sendRes = await req(
        "POST",
        `/messages/${channelId}`,
        { content: "Please handle this @Alpha.Bot" },
        human.token,
      );
      expect(sendRes.status).toBe(200);

      await waitForResult(async () => {
        const rows = await invocationsForMessage(sendRes.body.id);
        return rows.length > 0 ? rows : null;
      }, "Alpha.Bot invocation");
      await waitForResult(
        async () => (webhook.requests.length > 0 ? webhook.requests : null),
        "Alpha.Bot webhook request",
      );
      await sleep(100);

      const invocations = await invocationsForMessage(sendRes.body.id);
      expect(invocations.map((row) => row.botId)).toEqual([alpha.body.id]);
      expect(webhook.requests.map((request) => request.payload.bot.name)).toEqual(["Alpha.Bot"]);
    } finally {
      webhook.stop();
    }
  });

  test("handles case, regex characters, boundaries, and duplicate mentions", async () => {
    const webhook = startWebhookServer();
    try {
      const human = await registerUser("MentionCaseOwner");
      const { workspaceId, channelId } = await createWorkspaceWithGeneralChannel(
        human.token,
        "Mention Case WS",
      );

      const regexBot = await createBot(human.token, "Regex.Bot", webhook.url);
      const caseBot = await createBot(human.token, "CaseBot", webhook.url);
      await addBotToWorkspace(regexBot.body.id, workspaceId, human.token);
      await addBotToWorkspace(caseBot.body.id, workspaceId, human.token);

      await startBotWorkerForTest();
      const regexSend = await req(
        "POST",
        `/messages/${channelId}`,
        { content: "@regex.bot please handle the escaped-dot case" },
        human.token,
      );
      expect(regexSend.status).toBe(200);
      await waitForResult(async () => {
        const rows = await invocationsForMessage(regexSend.body.id);
        return rows.length > 0 ? rows : null;
      }, "case-insensitive regex bot invocation");
      expect((await invocationsForMessage(regexSend.body.id)).map((row) => row.botId)).toEqual([
        regexBot.body.id,
      ]);

      const boundarySend = await req(
        "POST",
        `/messages/${channelId}`,
        { content: "This should not match @CaseBotany" },
        human.token,
      );
      expect(boundarySend.status).toBe(200);
      await sleep(150);
      expect(await invocationsForMessage(boundarySend.body.id)).toEqual([]);

      const duplicateSend = await req(
        "POST",
        `/messages/${channelId}`,
        { content: "@casebot please respond once, even with @CaseBot twice" },
        human.token,
      );
      expect(duplicateSend.status).toBe(200);
      await waitForResult(async () => {
        const rows = await invocationsForMessage(duplicateSend.body.id);
        return rows.length > 0 ? rows : null;
      }, "deduplicated case bot invocation");
      expect((await invocationsForMessage(duplicateSend.body.id)).map((row) => row.botId)).toEqual([
        caseBot.body.id,
      ]);
      await waitForResult(
        async () => (webhook.requests.length >= 2 ? webhook.requests : null),
        "case and regex webhook requests",
      );
    } finally {
      webhook.stop();
    }
  });

  test("does not invoke bots without a mention or outside the conversation", async () => {
    const webhook = startWebhookServer();
    try {
      const human = await registerUser("MentionPermissionOwner");
      const { workspaceId, channelId } = await createWorkspaceWithGeneralChannel(
        human.token,
        "Mention Permission WS",
      );

      const participantBot = await createBot(human.token, "ParticipantBot", webhook.url);
      await createBot(human.token, "OutsideBot", webhook.url);
      await addBotToWorkspace(participantBot.body.id, workspaceId, human.token);

      const noMention = await req(
        "POST",
        `/messages/${channelId}`,
        { content: "No bot should be invoked here" },
        human.token,
      );
      expect(noMention.status).toBe(200);

      const outsideMention = await req(
        "POST",
        `/messages/${channelId}`,
        { content: "Even an explicit @OutsideBot mention should not cross participants" },
        human.token,
      );
      expect(outsideMention.status).toBe(200);

      await sleep(150);
      expect(await invocationsForMessage(noMention.body.id)).toEqual([]);
      expect(await invocationsForMessage(outsideMention.body.id)).toEqual([]);
      expect(webhook.requests).toEqual([]);
    } finally {
      webhook.stop();
    }
  });
});

describe("Bots: runtime state", () => {
  test("tracks queued, running, and completed state for webhook bots", async () => {
    const webhook = startWebhookServer();
    try {
      const human = await registerUser("RuntimeWebhookOwner");
      const { workspaceId, channelId } = await createWorkspaceWithGeneralChannel(
        human.token,
        "Runtime Webhook",
      );
      const botRes = await createBot(human.token, "RuntimeWebhook", webhook.url);
      await addBotToWorkspace(botRes.body.id, workspaceId, human.token);

      await startBotWorkerForTest();
      const sendRes = await req(
        "POST",
        `/messages/${channelId}`,
        { content: "@RuntimeWebhook please complete" },
        human.token,
      );
      expect(sendRes.status).toBe(200);

      const invocation = await waitForResult(async () => {
        const rows = await invocationsForMessage(sendRes.body.id);
        return rows.find((row) => row.status === "completed");
      }, "completed webhook invocation");

      expect(invocation.botId).toBe(botRes.body.id);
      expect(invocation.error).toBeNull();
      expect(webhook.requests).toHaveLength(1);
    } finally {
      webhook.stop();
    }
  });

  test("tracks Hermes completed, failed, and cancelled invocations and publishes runtime updates", async () => {
    const human = await registerUser("RuntimeHermesOwner");
    const { workspaceId } = await createWorkspaceWithGeneralChannel(
      human.token,
      "Runtime Hermes",
    );
    const botRes = await createBot(human.token, "RuntimeHermes", undefined, {
      kind: "hermes",
      workspaceId,
    });
    expect(botRes.status).toBe(200);

    const dmRes = await req(
      "POST",
      "/conversations/dm",
      { workspaceId, otherUserId: botRes.body.userId },
      human.token,
    );
    expect(dmRes.status).toBe(200);

    const redisKeyPrefix = `thechat-runtime-test-${crypto.randomUUID()}`;
    const serviceBus = new RedisRealtimeBus({ redisKeyPrefix });
    const observerBus = new RedisRealtimeBus({ redisKeyPrefix });
    const realtimeEvents: RealtimeEvent[] = [];
    await setRealtimeBusForTests(serviceBus);
    const unsubscribe = await observerBus.subscribe((event) => {
      realtimeEvents.push(event);
    });

    async function sendAndClaim(content: string) {
      const sendRes = await req("POST", `/messages/${dmRes.body.id}`, { content }, human.token);
      expect(sendRes.status).toBe(200);
      await waitForResult(async () => {
        const rows = await invocationsForMessage(sendRes.body.id);
        return rows.find((row) => row.status === "queued");
      }, `queued Hermes invocation for ${content}`);

      const claimRes = await req("GET", "/hermes-platform/events?limit=1", undefined, botRes.body.apiKey);
      expect(claimRes.status).toBe(200);
      expect(claimRes.body.events).toHaveLength(1);
      return {
        messageId: sendRes.body.id as string,
        invocationId: claimRes.body.events[0].invocationId as string,
      };
    }

    try {
      const completed = await sendAndClaim("Complete this Hermes invocation");
      const progressRes = await req(
        "POST",
        `/hermes-platform/invocations/${completed.invocationId}/progress`,
        {
          type: "tool.started",
          status: "running",
          toolCallId: "call-1",
          toolName: "shell",
          label: "Shell: pnpm test",
          payload: { args: { command: "pnpm test" } },
          occurredAt: new Date().toISOString(),
        },
        botRes.body.apiKey,
      );
      expect(progressRes.status).toBe(200);
      expect(progressRes.body.event.invocationId).toBe(completed.invocationId);
      expect(progressRes.body.event.toolCallId).toBe("call-1");

      const completeRes = await req(
        "POST",
        "/hermes-platform/messages",
        {
          invocationId: completed.invocationId,
          content: "Hermes completed response",
        },
        botRes.body.apiKey,
      );
      expect(completeRes.status).toBe(200);

      const failed = await sendAndClaim("Fail this Hermes invocation");
      const failRes = await req(
        "POST",
        `/hermes-platform/invocations/${failed.invocationId}/failed`,
        { error: "synthetic failure" },
        botRes.body.apiKey,
      );
      expect(failRes.status).toBe(200);

      const cancelled = await sendAndClaim("Cancel this Hermes invocation");
      const cancelRes = await req(
        "POST",
        `/hermes-platform/invocations/${cancelled.invocationId}/cancelled`,
        { reason: "synthetic cancellation" },
        botRes.body.apiKey,
      );
      expect(cancelRes.status).toBe(200);

      await waitForResult(async () => {
        const rows = await invocationsForMessage(completed.messageId);
        return rows.find((row) => row.status === "completed" && row.responseMessageId);
      }, "completed Hermes invocation");
      const runtimeRes = await req(
        "GET",
        `/bot-runtime/conversations/${dmRes.body.id}`,
        undefined,
        human.token,
      );
      expect(runtimeRes.status).toBe(200);
      expect(runtimeRes.body.events).toContainEqual(
        expect.objectContaining({
          invocationId: completed.invocationId,
          type: "tool.started",
          toolName: "shell",
        }),
      );

      await waitForResult(async () => {
        const rows = await invocationsForMessage(failed.messageId);
        return rows.find((row) => row.status === "failed" && row.error === "synthetic failure");
      }, "failed Hermes invocation");
      await waitForResult(async () => {
        const rows = await invocationsForMessage(cancelled.messageId);
        return rows.find((row) => row.status === "cancelled" && row.error === "synthetic cancellation");
      }, "cancelled Hermes invocation");

      const cancelledRuntimeUpdate = await waitForResult(() => {
        const event = realtimeEvents.find(
          (candidate) =>
            candidate.type === "ws.event" &&
            candidate.event.type === "bot_invocation_updated" &&
            candidate.event.invocation.id === cancelled.invocationId &&
            candidate.event.invocation.status === "cancelled",
        );
        return Promise.resolve(event);
      }, "cancelled bot_invocation_updated realtime event");
      expect(cancelledRuntimeUpdate.type).toBe("ws.event");
      if (cancelledRuntimeUpdate.type !== "ws.event") {
        throw new Error("Expected realtime websocket event");
      }
      expect(cancelledRuntimeUpdate.targetUserIds).toContain(human.user.id);

      const progressRuntimeEvent = await waitForResult(() => {
        const event = realtimeEvents.find(
          (candidate) =>
            candidate.type === "ws.event" &&
            candidate.event.type === "bot_invocation_progress" &&
            candidate.event.invocationId === completed.invocationId &&
            candidate.event.event.toolName === "shell",
        );
        return Promise.resolve(event);
      }, "Hermes progress realtime event");
      expect(progressRuntimeEvent.type).toBe("ws.event");
      if (progressRuntimeEvent.type !== "ws.event") {
        throw new Error("Expected realtime websocket event");
      }
      expect(progressRuntimeEvent.targetUserIds).toContain(human.user.id);
    } finally {
      await unsubscribe();
      await observerBus.close();
      await closeRealtimeBusForTests();
    }
  });

  test("Hermes platform supports regular bot webhook delivery while polling remains available", async () => {
    let receivedAuthorization = "";
    const webhook = startWebhookServer((request) => {
      receivedAuthorization = request.headers.get("authorization") ?? "";
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    });
    const human = await registerUser("RuntimeHermesWebhookOwner");
    const { workspaceId } = await createWorkspaceWithGeneralChannel(
      human.token,
      "Runtime Hermes Platform Webhook",
    );
    const botRes = await createBot(human.token, "RuntimeHermesWebhook", undefined, {
      kind: "hermes",
      workspaceId,
    });
    expect(botRes.status).toBe(200);

    const registerRes = await req(
      "POST",
      "/bots/me/webhook",
      { url: webhook.url },
      botRes.body.apiKey,
    );
    expect(registerRes.status).toBe(200);
    expect(registerRes.body.webhookUrl).toBe(webhook.url);

    const pollingRes = await req("GET", "/hermes-platform/events?limit=1", undefined, botRes.body.apiKey);
    expect(pollingRes.status).toBe(200);
    expect(pollingRes.body.events).toEqual([]);

    const dmRes = await req(
      "POST",
      "/conversations/dm",
      { workspaceId, otherUserId: botRes.body.userId },
      human.token,
    );
    expect(dmRes.status).toBe(200);

    try {
      await startBotWorkerForTest();
      const sendRes = await req(
        "POST",
        `/messages/${dmRes.body.id}`,
        { content: "Handle this over the platform webhook" },
        human.token,
      );
      expect(sendRes.status).toBe(200);

      const delivery = await waitForResult(async () => {
        return webhook.requests.find((request) => request.payload.event?.messageId === sendRes.body.id);
      }, "Hermes platform webhook event");

      expect(receivedAuthorization).toBe(`Bearer ${botRes.body.apiKey}`);
      expect(delivery.payload.type).toBe("thechat.hermes_platform.event");
      expect(delivery.payload.event.text).toBe("Handle this over the platform webhook");
      expect(delivery.payload.event.bot.id).toBe(botRes.body.id);
      const [invocation] = await invocationsForMessage(sendRes.body.id);
      expect(invocation.status).toBe("running");
    } finally {
      webhook.stop();
    }
  });

  test("Hermes platform webhook delivery is performed by the bot worker", async () => {
    await closeBotRuntimeForTests();

    const webhook = startWebhookServer();
    const human = await registerUser("RuntimeHermesWorkerWebhookOwner");
    const { workspaceId } = await createWorkspaceWithGeneralChannel(
      human.token,
      "Runtime Hermes Worker Webhook",
    );
    const botRes = await createBot(human.token, "RuntimeHermesWorkerWebhook", undefined, {
      kind: "hermes",
      workspaceId,
    });
    expect(botRes.status).toBe(200);

    const registerRes = await req(
      "POST",
      "/bots/me/webhook",
      { url: webhook.url },
      botRes.body.apiKey,
    );
    expect(registerRes.status).toBe(200);

    const dmRes = await req(
      "POST",
      "/conversations/dm",
      { workspaceId, otherUserId: botRes.body.userId },
      human.token,
    );
    expect(dmRes.status).toBe(200);

    try {
      const sendRes = await req(
        "POST",
        `/messages/${dmRes.body.id}`,
        { content: "Deliver this through the bot worker" },
        human.token,
      );
      expect(sendRes.status).toBe(200);

      await waitForResult(async () => {
        const rows = await invocationsForMessage(sendRes.body.id);
        return rows.find((row) => row.status === "queued");
      }, "queued Hermes webhook invocation");
      await sleep(150);
      expect(webhook.requests).toHaveLength(0);

      await startBotWorkerForTest();
      const delivery = await waitForResult(async () => {
        return webhook.requests.find((request) => request.payload.event?.messageId === sendRes.body.id);
      }, "worker-delivered Hermes webhook event");

      expect(delivery.payload.type).toBe("thechat.hermes_platform.event");
      expect(delivery.payload.event.text).toBe("Deliver this through the bot worker");
      const [invocation] = await invocationsForMessage(sendRes.body.id);
      expect(invocation.status).toBe("running");
    } finally {
      webhook.stop();
      await closeBotRuntimeForTests();
    }
  });
});

describe("Bots: @mention webhook", () => {
  test("webhook receives payload with valid signature when bot is @mentioned", async () => {
    const human = await registerUser("WebhookOwner");

    // Set up a mock webhook server
    let receivedPayload: any = null;
    let receivedHeaders: Record<string, string> = {};
    let receivedBody: string = "";
    let webhookSecret: string = "";
    const webhookPromise = new Promise<void>((resolve) => {
      const server = Bun.serve({
        port: 0, // random available port
        async fetch(request) {
          receivedBody = await request.text();
          receivedPayload = JSON.parse(receivedBody);
          receivedHeaders = {
            "x-webhook-timestamp":
              request.headers.get("x-webhook-timestamp") ?? "",
            "x-webhook-signature":
              request.headers.get("x-webhook-signature") ?? "",
          };
          resolve();
          // Schedule server stop for next tick
          setTimeout(() => server.stop(), 0);
          return new Response("ok");
        },
      });

      const webhookUrl = `http://localhost:${server.port}/webhook`;

      // Run the test flow
      (async () => {
        // Create workspace
        const wsRes = await req(
          "POST",
          "/workspaces/create",
          { name: "Webhook WS" },
          human.token
        );
        createdWorkspaceIds.push(wsRes.body.id);

        // Create bot with webhook URL
        const botRes = await createBot(
          human.token,
          "WebhookBot",
          webhookUrl
        );

        // Store the secret for verification
        webhookSecret = botRes.body.webhookSecret;

        // Add bot to workspace
        await req(
          "POST",
          `/bots/${botRes.body.id}/workspaces`,
          { workspaceId: wsRes.body.id },
          human.token
        );

        // Get the general channel
        const detailRes = await req(
          "GET",
          `/workspaces/${wsRes.body.id}`,
          undefined,
          human.token
        );
        const channelId = detailRes.body.channels[0].id;

        // Send a message mentioning the bot
        await startBotWorkerForTest();
        await req(
          "POST",
          `/messages/${channelId}`,
          { content: "Hey @WebhookBot what do you think?" },
          human.token
        );
      })();
    });

    // Wait for webhook to be called (timeout 5s)
    await Promise.race([
      webhookPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Webhook timeout")), 5000)
      ),
    ]);

    expect(receivedPayload).not.toBeNull();
    expect(receivedPayload.event).toBe("mention");
    expect(receivedPayload.message.content).toBe(
      "Hey @WebhookBot what do you think?"
    );
    expect(receivedPayload.bot.name).toBe("WebhookBot");
    expect(receivedPayload.conversation).toBeDefined();
    expect(receivedPayload.workspace).toBeDefined();
    expect(receivedPayload.workspace.name).toBe("Webhook WS");

    // Verify signature headers are present
    expect(receivedHeaders["x-webhook-timestamp"]).toBeTruthy();
    expect(receivedHeaders["x-webhook-signature"]).toBeTruthy();

    // Verify the signature is correct
    const timestamp = receivedHeaders["x-webhook-timestamp"];
    const signedContent = `${timestamp}.${receivedBody}`;
    const expectedSignature = crypto
      .createHmac("sha256", webhookSecret)
      .update(signedContent)
      .digest("hex");
    expect(receivedHeaders["x-webhook-signature"]).toBe(expectedSignature);
  });
});
