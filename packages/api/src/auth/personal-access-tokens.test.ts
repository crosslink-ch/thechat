import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { apikey, users } from "../db/schema";
import { mcpRoutes } from "../mcp";
import { mcpAuthenticate } from "../mcp/auth";
import { authRoutes } from "./index";
import {
  auth,
  PERSONAL_ACCESS_TOKEN_CONFIG_ID,
  PERSONAL_ACCESS_TOKEN_PREFIX,
} from "./better-auth";

const userIds: string[] = [];
const sessionTokens: string[] = [];

async function request(
  method: string,
  path: string,
  bearer?: string,
  body?: unknown,
) {
  const headers = new Headers();
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  return authRoutes.handle(
    new Request(`http://localhost/auth${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function createToken(sessionToken: string, name: string) {
  const response = await request("POST", "/personal-access-tokens", sessionToken, {
    name,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    token: string;
    personalAccessToken: {
      id: string;
      name: string;
      start: string | null;
      createdAt: string;
      lastUsedAt: string | null;
    };
  };
}

function mcpPost(token: string, body: unknown, sessionId?: string) {
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "mcp-protocol-version": "2025-03-26",
  });
  if (sessionId) headers.set("mcp-session-id", sessionId);
  return mcpRoutes.handle(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

function mcpInitialize(token: string) {
  return mcpPost(token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "thechat-pat-test", version: "1.0.0" },
    },
  });
}

beforeAll(async () => {
  for (const name of ["PAT owner", "Other PAT owner"]) {
    const email = `pat-${crypto.randomUUID()}@example.com`;
    const response = await request("POST", "/register", undefined, {
      name,
      email,
      password: "correct-horse-battery-staple",
    });
    expect(response.status).toBe(200);
    const registered = (await response.json()) as {
      accessToken: string;
      user: { id: string };
    };
    userIds.push(registered.user.id);
    sessionTokens.push(registered.accessToken);
  }

  const now = new Date();
  const botId = crypto.randomUUID();
  userIds.push(botId);
  await db.insert(users).values({
    id: botId,
    name: "Non-human PAT reference",
    email: `pat-bot-${botId}@example.com`,
    emailVerified: true,
    type: "bot",
    createdAt: now,
    updatedAt: now,
  });
});

afterAll(async () => {
  await db.delete(users).where(inArray(users.id, userIds));
});

describe("personal access tokens", () => {
  test("creates multiple named tokens, stores only hashes, and lists safe metadata", async () => {
    const first = await createToken(sessionTokens[0], "  Local automation  ");
    const second = await createToken(sessionTokens[0], "MCP client");

    expect(first.token.startsWith(PERSONAL_ACCESS_TOKEN_PREFIX)).toBe(true);
    expect(second.token.startsWith(PERSONAL_ACCESS_TOKEN_PREFIX)).toBe(true);
    expect(first.token).not.toBe(second.token);
    expect(first.personalAccessToken.name).toBe("Local automation");
    expect(first.personalAccessToken.start).toBe(
      first.token.slice(0, PERSONAL_ACCESS_TOKEN_PREFIX.length + 6),
    );

    const stored = await db
      .select()
      .from(apikey)
      .where(eq(apikey.referenceId, userIds[0]));
    const storedPersonal = stored.filter(
      (item) => item.configId === PERSONAL_ACCESS_TOKEN_CONFIG_ID,
    );
    expect(storedPersonal.length).toBeGreaterThanOrEqual(2);
    expect(storedPersonal.every((item) => item.expiresAt === null)).toBe(true);
    expect(storedPersonal.some((item) => item.key === first.token)).toBe(false);
    expect(storedPersonal.some((item) => item.key === second.token)).toBe(false);

    const listResponse = await request(
      "GET",
      "/personal-access-tokens",
      sessionTokens[0],
    );
    expect(listResponse.status).toBe(200);
    const listed = (await listResponse.json()) as {
      personalAccessTokens: Array<Record<string, unknown>>;
    };
    const firstListed = listed.personalAccessTokens.find(
      (item) => item.id === first.personalAccessToken.id,
    );
    const secondListed = listed.personalAccessTokens.find(
      (item) => item.id === second.personalAccessToken.id,
    );
    expect(firstListed?.name).toBe("Local automation");
    expect(secondListed?.name).toBe("MCP client");
    for (const item of listed.personalAccessTokens) {
      expect(Object.keys(item).sort()).toEqual([
        "createdAt",
        "id",
        "lastUsedAt",
        "name",
        "start",
      ]);
    }
    const serialized = JSON.stringify(listed);
    expect(serialized.includes(first.token)).toBe(false);
    expect(serialized.includes(second.token)).toBe(false);
    expect(serialized.includes(storedPersonal[0]!.key)).toBe(false);

    expect(
      (
        await request(
          "DELETE",
          `/personal-access-tokens/${first.personalAccessToken.id}`,
          sessionTokens[0],
        )
      ).status,
    ).toBe(200);
    expect((await request("GET", "/me", first.token)).status).toBe(401);
    expect((await request("GET", "/me", second.token)).status).toBe(200);
  });

  test("accepts a PAT for /auth/me and MCP, updates last-used, then rejects it after revocation", async () => {
    const created = await createToken(sessionTokens[0], "Lifecycle token");

    const me = await request("GET", "/me", created.token);
    expect(me.status).toBe(200);
    expect(
      ((await me.json()) as { user: { id: string } }).user.id,
    ).toBe(userIds[0]);

    const profileUpdate = await request("PATCH", "/me", created.token, {
      name: "PAT owner renamed",
    });
    expect(profileUpdate.status).toBe(200);
    expect(
      ((await profileUpdate.json()) as { user: { id: string; name: string } })
        .user,
    ).toMatchObject({ id: userIds[0], name: "PAT owner renamed" });

    const mcpUser = await mcpAuthenticate({
      request: new Request("http://localhost/mcp", {
        headers: { authorization: `Bearer ${created.token}` },
      }),
    });
    expect(mcpUser).toMatchObject({
      authInfo: { id: userIds[0], type: "human" },
    });
    const sessionInitialized = await mcpInitialize(sessionTokens[0]);
    expect(sessionInitialized.status).toBe(200);
    await sessionInitialized.text();

    const initialized = await mcpInitialize(created.token);
    expect(initialized.status).toBe(200);
    const mcpSessionId = initialized.headers.get("mcp-session-id");
    expect(mcpSessionId).toBeTruthy();
    expect(await initialized.text()).toContain('"result"');

    const notified = await mcpPost(
      created.token,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      mcpSessionId!,
    );
    expect([200, 202]).toContain(notified.status);
    await notified.text();

    const toolsResponse = await mcpPost(
      created.token,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      mcpSessionId!,
    );
    expect(toolsResponse.status).toBe(200);
    const toolsPayload = await toolsResponse.text();
    expect(toolsPayload).toContain("create_hermes_bot");
    expect(toolsPayload).toContain("get_hermes_bot_capabilities");

    const callResponse = await mcpPost(
      created.token,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_workspaces", arguments: {} },
      },
      mcpSessionId!,
    );
    expect(callResponse.status).toBe(200);
    expect(await callResponse.text()).toContain('"result"');

    const list = await request(
      "GET",
      "/personal-access-tokens",
      sessionTokens[0],
    );
    const listed = (await list.json()) as {
      personalAccessTokens: Array<{ id: string; lastUsedAt: string | null }>;
    };
    expect(
      listed.personalAccessTokens.find(
        (item) => item.id === created.personalAccessToken.id,
      )?.lastUsedAt,
    ).not.toBeNull();

    const revoked = await request(
      "DELETE",
      `/personal-access-tokens/${created.personalAccessToken.id}`,
      sessionTokens[0],
    );
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ success: true });

    expect((await request("GET", "/me", created.token)).status).toBe(401);
    const revokedMcp = await mcpAuthenticate({
      request: new Request("http://localhost/mcp", {
        headers: { authorization: `Bearer ${created.token}` },
      }),
    });
    expect(revokedMcp.authInfo).toBeUndefined();
    expect(revokedMcp.response?.status).toBe(401);
    expect(
      (
        await mcpPost(
          created.token,
          { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} },
          mcpSessionId!,
        )
      ).status,
    ).toBe(401);
    expect((await mcpInitialize(created.token)).status).toBe(401);
  });

  test("allows only sessions to create, list, or revoke tokens", async () => {
    const created = await createToken(sessionTokens[0], "No delegation");

    expect(
      (
        await request("POST", "/personal-access-tokens", undefined, {
          name: "Unauthenticated token",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request("POST", "/personal-access-tokens", undefined, {
          name: "   ",
        })
      ).status,
    ).toBe(401);

    expect(
      (
        await request("POST", "/personal-access-tokens", created.token, {
          name: "Forbidden child token",
        })
      ).status,
    ).toBe(401);
    expect(
      (await request("GET", "/personal-access-tokens", created.token)).status,
    ).toBe(401);
    expect(
      (
        await request(
          "DELETE",
          `/personal-access-tokens/${created.personalAccessToken.id}`,
          created.token,
        )
      ).status,
    ).toBe(401);

    // The failed PAT-authenticated revoke did not revoke the credential.
    expect((await request("GET", "/me", created.token)).status).toBe(200);
  });

  test("keeps token listing and revocation isolated by owner", async () => {
    const ownerToken = await createToken(sessionTokens[0], "Owner only");
    const otherToken = await createToken(sessionTokens[1], "Other owner");

    const otherList = await request(
      "GET",
      "/personal-access-tokens",
      sessionTokens[1],
    );
    expect(otherList.status).toBe(200);
    const payload = (await otherList.json()) as {
      personalAccessTokens: Array<{ id: string }>;
    };
    expect(payload.personalAccessTokens.some((item) => item.id === otherToken.personalAccessToken.id)).toBe(true);
    expect(payload.personalAccessTokens.some((item) => item.id === ownerToken.personalAccessToken.id)).toBe(false);

    const crossRevoke = await request(
      "DELETE",
      `/personal-access-tokens/${ownerToken.personalAccessToken.id}`,
      sessionTokens[1],
    );
    expect(crossRevoke.status).toBe(404);
    expect((await request("GET", "/me", ownerToken.token)).status).toBe(200);
  });

  test("requires a trimmed name and never resolves a personal token to a bot", async () => {
    expect(
      (
        await request("POST", "/personal-access-tokens", sessionTokens[0], {
          name: "   ",
        })
      ).status,
    ).toBe(400);

    const botReferenced = await auth.api.createApiKey({
      body: {
        configId: PERSONAL_ACCESS_TOKEN_CONFIG_ID,
        name: "Invalid bot-owned personal key",
        userId: userIds[2],
      },
    });
    expect(botReferenced.key.startsWith(PERSONAL_ACCESS_TOKEN_PREFIX)).toBe(true);
    expect((await request("GET", "/me", botReferenced.key)).status).toBe(401);
  });
});
