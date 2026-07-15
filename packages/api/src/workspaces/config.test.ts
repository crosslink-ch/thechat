import { afterAll, describe, expect, test } from "bun:test";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { authRoutes } from "../auth";
import { db } from "../db";
import {
  bots,
  users,
  workspaceConfigs,
  workspaceMembers,
  workspaces,
} from "../db/schema";
import { workspaceConfigRoutes } from "./config";

const app = new Elysia().use(authRoutes).use(workspaceConfigRoutes);
const createdWorkspaceIds: string[] = [];
const createdUserIds: string[] = [];

async function request(
  method: string,
  path: string,
  token: string,
  body?: unknown,
) {
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
  return { status: response.status, body: await response.json() };
}

async function register(name: string) {
  const email = `config-${crypto.randomUUID()}@test.com`;
  const response = await app.handle(
    new Request("http://localhost/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, email, password: "password123" }),
    }),
  );
  const body = (await response.json()) as any;
  createdUserIds.push(body.user.id);
  return body;
}

afterAll(async () => {
  for (const workspaceId of createdWorkspaceIds) {
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  }
  for (const userId of createdUserIds) {
    await db.delete(users).where(eq(users.id, userId));
  }
});

describe("workspace provider configuration human/bot boundary", () => {
  test("denies every read/mutation route to a bot member and requires human admin role", async () => {
    const owner = await register("Config Owner");
    const member = await register("Config Member");
    const workspaceId = `config-${crypto.randomUUID()}`;
    createdWorkspaceIds.push(workspaceId);
    await db.insert(workspaces).values({
      id: workspaceId,
      name: "Provider Secrets",
      createdById: owner.user.id,
    });
    await db.insert(workspaceMembers).values([
      { workspaceId, userId: owner.user.id, role: "owner" },
      { workspaceId, userId: member.user.id, role: "member" },
    ]);

    const [botUser] = await db
      .insert(users)
      .values({ name: "Config Bot", type: "bot" })
      .returning({ id: users.id });
    createdUserIds.push(botUser.id);
    const botToken = `bot_${crypto.randomBytes(32).toString("hex")}`;
    await db.insert(bots).values({
      userId: botUser.id,
      ownerId: owner.user.id,
      webhookSecret: `whsec_${crypto.randomBytes(16).toString("hex")}`,
      apiKey: botToken,
    });
    await db.insert(workspaceMembers).values({
      workspaceId,
      userId: botUser.id,
      role: "member",
    });
    await db.insert(workspaceConfigs).values({
      workspaceId,
      provider: "openrouter",
      openrouterApiKey: "sk-secret-provider-key",
    });

    const deniedCalls: Array<[string, string, unknown?]> = [
      ["GET", `/workspaces/${workspaceId}/config`],
      ["PUT", `/workspaces/${workspaceId}/config/openrouter`, { apiKey: "x" }],
      ["PUT", `/workspaces/${workspaceId}/config/glm`, { apiKey: "x" }],
      ["PUT", `/workspaces/${workspaceId}/config/featherless`, { apiKey: "x" }],
      ["PUT", `/workspaces/${workspaceId}/config/provider`, { provider: "codex" }],
      ["PUT", `/workspaces/${workspaceId}/config/settings`, { codexModel: "gpt-5" }],
      ["DELETE", `/workspaces/${workspaceId}/config`],
    ];
    for (const [method, path, body] of deniedCalls) {
      const response = await request(method, path, botToken, body);
      expect(response.status).toBe(401);
      expect(JSON.stringify(response.body)).not.toContain(
        "sk-secret-provider-key",
      );
    }

    expect(
      (await request("GET", `/workspaces/${workspaceId}/config`, member.accessToken))
        .status,
    ).toBe(403);
    const ownerRead = await request(
      "GET",
      `/workspaces/${workspaceId}/config`,
      owner.accessToken,
    );
    expect(ownerRead.status).toBe(200);
    expect((ownerRead.body as any).openrouter.apiKey).toBe(
      "sk-secret-provider-key",
    );
  });
});
