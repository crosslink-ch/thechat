import { describe, test, expect, afterAll } from "bun:test";
import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users, workspaces } from "../db/schema";
import { authRoutes } from "../auth";
import { workspaceRoutes } from "../workspaces";
import { conversationRoutes } from "../conversations";
import { messageRoutes } from "../messages";
import crypto from "crypto";

const app = new Elysia()
  .use(authRoutes)
  .use(workspaceRoutes)
  .use(conversationRoutes)
  .use(messageRoutes);

function uniqueEmail() {
  return `test-${crypto.randomUUID()}@test.com`;
}

const createdUserEmails: string[] = [];
const createdWorkspaceIds: string[] = [];

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
    if (user) {
      await db.delete(users).where(eq(users.id, user.id));
    }
  }
});

async function req(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
) {
  const headers: Record<string, string> = {};
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
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
  const email = uniqueEmail();
  createdUserEmails.push(email);

  const res = await req("POST", "/auth/register", {
    name,
    email,
    password: "password123",
  });

  return { token: res.body.token as string, user: res.body.user };
}

describe("Channel message visibility", () => {
  test("User B can see messages sent by User A in a shared channel", async () => {
    // 1. Register both users
    const userA = await registerUser("Alice");
    const userB = await registerUser("Bob");

    // 2. User A creates a workspace
    const createRes = await req(
      "POST",
      "/workspaces/create",
      { name: "Visibility Test" },
      userA.token,
    );
    expect(createRes.status).toBe(200);
    const workspaceId = createRes.body.id;
    createdWorkspaceIds.push(workspaceId);

    // 3. User B joins the workspace
    const joinRes = await req(
      "POST",
      "/workspaces/join",
      { workspaceId },
      userB.token,
    );
    expect(joinRes.status).toBe(200);

    // 4. Get the General channel ID
    const detailRes = await req(
      "GET",
      `/workspaces/${workspaceId}`,
      undefined,
      userA.token,
    );
    expect(detailRes.status).toBe(200);
    const generalChannel = detailRes.body.channels.find(
      (c: any) => c.name === "general",
    );
    expect(generalChannel).toBeDefined();
    const channelId = generalChannel.id;

    // 5. User A sends a message to the general channel
    const sendRes = await req(
      "POST",
      `/messages/${channelId}`,
      { content: "Hello from Alice!" },
      userA.token,
    );
    expect(sendRes.status).toBe(200);
    expect(sendRes.body.content).toBe("Hello from Alice!");

    // 6. User B fetches messages from the same channel
    const fetchRes = await req(
      "GET",
      `/messages/${channelId}`,
      undefined,
      userB.token,
    );
    expect(fetchRes.status).toBe(200);
    expect(fetchRes.body).toBeInstanceOf(Array);
    expect(fetchRes.body.length).toBeGreaterThanOrEqual(1);

    const aliceMessage = fetchRes.body.find(
      (m: any) => m.content === "Hello from Alice!",
    );
    expect(aliceMessage).toBeDefined();
    expect(aliceMessage.senderId).toBe(userA.user.id);
    expect(aliceMessage.senderName).toBe("Alice");
  });

  test("non-participant cannot see channel messages", async () => {
    const userA = await registerUser("Alice");
    const stranger = await registerUser("Stranger");

    const createRes = await req(
      "POST",
      "/workspaces/create",
      { name: "Private WS" },
      userA.token,
    );
    createdWorkspaceIds.push(createRes.body.id);

    const detailRes = await req(
      "GET",
      `/workspaces/${createRes.body.id}`,
      undefined,
      userA.token,
    );
    const channelId = detailRes.body.channels[0].id;

    await req(
      "POST",
      `/messages/${channelId}`,
      { content: "Secret message" },
      userA.token,
    );

    // Stranger tries to read the channel
    const fetchRes = await req(
      "GET",
      `/messages/${channelId}`,
      undefined,
      stranger.token,
    );
    expect(fetchRes.status).toBe(403);
  });

  test("multiple messages maintain order", async () => {
    const userA = await registerUser("Alice");
    const userB = await registerUser("Bob");

    const createRes = await req(
      "POST",
      "/workspaces/create",
      { name: "Order Test" },
      userA.token,
    );
    createdWorkspaceIds.push(createRes.body.id);

    await req(
      "POST",
      "/workspaces/join",
      { workspaceId: createRes.body.id },
      userB.token,
    );

    const detailRes = await req(
      "GET",
      `/workspaces/${createRes.body.id}`,
      undefined,
      userA.token,
    );
    const channelId = detailRes.body.channels[0].id;

    // Both users send messages
    await req(
      "POST",
      `/messages/${channelId}`,
      { content: "First from Alice" },
      userA.token,
    );
    await req(
      "POST",
      `/messages/${channelId}`,
      { content: "Reply from Bob" },
      userB.token,
    );
    await req(
      "POST",
      `/messages/${channelId}`,
      { content: "Second from Alice" },
      userA.token,
    );

    // Both users see all messages in chronological order
    const fetchA = await req(
      "GET",
      `/messages/${channelId}`,
      undefined,
      userA.token,
    );
    const fetchB = await req(
      "GET",
      `/messages/${channelId}`,
      undefined,
      userB.token,
    );

    for (const fetch of [fetchA, fetchB]) {
      expect(fetch.status).toBe(200);
      expect(fetch.body).toHaveLength(3);
      expect(fetch.body[0].content).toBe("First from Alice");
      expect(fetch.body[1].content).toBe("Reply from Bob");
      expect(fetch.body[2].content).toBe("Second from Alice");
    }
  });
});
