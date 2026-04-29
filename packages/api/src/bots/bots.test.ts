import { describe, test, expect, afterAll } from "bun:test";
import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users, workspaces, bots } from "../db/schema";
import { authRoutes } from "../auth";
import { workspaceRoutes } from "../workspaces";
import { conversationRoutes } from "../conversations";
import { messageRoutes } from "../messages";
import { botRoutes } from "./index";
import crypto from "crypto";

const app = new Elysia()
  .use(authRoutes)
  .use(workspaceRoutes)
  .use(conversationRoutes)
  .use(messageRoutes)
  .use(botRoutes);

function uniqueEmail() {
  return `test-${crypto.randomUUID()}@test.com`;
}

const createdUserEmails: string[] = [];
const createdWorkspaceIds: string[] = [];
const createdBotUserIds: string[] = [];

afterAll(async () => {
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
  webhookUrl?: string
) {
  const res = await req(
    "POST",
    "/bots/create",
    { name, webhookUrl },
    ownerToken
  );
  if (res.body.userId) {
    createdBotUserIds.push(res.body.userId);
  }
  return res;
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

    // New fields surfaced in the structured payload
    expect(receivedPayload.message.senderType).toBe("human");
    expect(receivedPayload.conversation.kind).toBe("channel");
    expect(receivedPayload.bot.userId).toBeDefined();
  });

  test("DM to bot fires direct_message webhook (no @mention required)", async () => {
    const human = await registerUser("DmHookOwner");

    let receivedPayload: any = null;
    const got = new Promise<void>((resolve) => {
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          const text = await request.text();
          receivedPayload = JSON.parse(text);
          resolve();
          setTimeout(() => server.stop(), 0);
          return new Response("ok");
        },
      });

      const webhookUrl = `http://localhost:${server.port}/webhook`;
      (async () => {
        const wsRes = await req(
          "POST",
          "/workspaces/create",
          { name: "DM hook WS" },
          human.token
        );
        createdWorkspaceIds.push(wsRes.body.id);

        const botRes = await createBot(human.token, "DmHookBot", webhookUrl);
        await req(
          "POST",
          `/bots/${botRes.body.id}/workspaces`,
          { workspaceId: wsRes.body.id },
          human.token
        );

        const dmRes = await req(
          "POST",
          "/conversations/dm",
          { workspaceId: wsRes.body.id, otherUserId: botRes.body.userId },
          human.token
        );
        await req(
          "POST",
          `/messages/${dmRes.body.id}`,
          { content: "no mention needed" },
          human.token
        );
      })();
    });

    await Promise.race([
      got,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Webhook timeout")), 5000)
      ),
    ]);

    expect(receivedPayload).not.toBeNull();
    expect(receivedPayload.event).toBe("direct_message");
    expect(receivedPayload.conversation.kind).toBe("dm");
    expect(receivedPayload.message.content).toBe("no mention needed");
  });

  test("bot's own messages do not loop back to its webhook", async () => {
    // Set up a bot with a webhook server, then have the bot send a DM to
    // itself — wait briefly and assert the webhook was NOT hit.
    const human = await registerUser("LoopOwner");

    let webhookHits = 0;
    const server = Bun.serve({
      port: 0,
      async fetch() {
        webhookHits += 1;
        return new Response("ok");
      },
    });
    try {
      const webhookUrl = `http://localhost:${server.port}/webhook`;

      const wsRes = await req(
        "POST",
        "/workspaces/create",
        { name: "Loop WS" },
        human.token
      );
      createdWorkspaceIds.push(wsRes.body.id);

      const botRes = await createBot(human.token, "LoopBot", webhookUrl);
      await req(
        "POST",
        `/bots/${botRes.body.id}/workspaces`,
        { workspaceId: wsRes.body.id },
        human.token
      );

      const detailRes = await req(
        "GET",
        `/workspaces/${wsRes.body.id}`,
        undefined,
        human.token
      );
      const channelId = detailRes.body.channels[0].id;

      // Bot mentions itself in the channel (using the bot API key as auth).
      await req(
        "POST",
        `/messages/${channelId}`,
        { content: "I am @LoopBot, hello me" },
        botRes.body.apiKey
      );

      // Give the fire-and-forget delivery a moment.
      await new Promise((r) => setTimeout(r, 250));

      expect(webhookHits).toBe(0);
    } finally {
      server.stop();
    }
  });

  test("messages from another bot do not fan out to peer bot webhooks", async () => {
    const human = await registerUser("CrossBotOwner");

    let webhookHits = 0;
    const server = Bun.serve({
      port: 0,
      async fetch() {
        webhookHits += 1;
        return new Response("ok");
      },
    });
    try {
      const webhookUrl = `http://localhost:${server.port}/webhook`;

      const wsRes = await req(
        "POST",
        "/workspaces/create",
        { name: "CrossBot WS" },
        human.token
      );
      createdWorkspaceIds.push(wsRes.body.id);

      // Bot A has a webhook, Bot B is silent.
      const botA = await createBot(human.token, "CrossBotA", webhookUrl);
      const botB = await createBot(human.token, "CrossBotB");

      await req(
        "POST",
        `/bots/${botA.body.id}/workspaces`,
        { workspaceId: wsRes.body.id },
        human.token
      );
      await req(
        "POST",
        `/bots/${botB.body.id}/workspaces`,
        { workspaceId: wsRes.body.id },
        human.token
      );

      const detailRes = await req(
        "GET",
        `/workspaces/${wsRes.body.id}`,
        undefined,
        human.token
      );
      const channelId = detailRes.body.channels[0].id;

      // Bot B mentions Bot A — without bot-loop prevention, A would receive a
      // webhook. With the new gating, A is skipped because the sender is a bot.
      await req(
        "POST",
        `/messages/${channelId}`,
        { content: "yo @CrossBotA" },
        botB.body.apiKey
      );

      await new Promise((r) => setTimeout(r, 250));
      expect(webhookHits).toBe(0);
    } finally {
      server.stop();
    }
  });
});
