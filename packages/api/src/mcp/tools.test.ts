import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { db } from "../db";
import { users, workspaceMembers, workspaces } from "../db/schema";
import type { McpUser as AuthUser } from "./auth";
import { registerTools } from "./tools";

type RegisteredTool = {
  config: unknown;
  handler: (
    args: Record<string, unknown>,
    extra: { authInfo?: AuthUser },
  ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
};

const tools = new Map<string, RegisteredTool>();
const fakeServer = {
  registerTool(
    name: string,
    config: unknown,
    handler: RegisteredTool["handler"],
  ) {
    tools.set(name, { config, handler });
  },
};

const ownerId = crypto.randomUUID();
const outsiderId = crypto.randomUUID();
const workspaceId = crypto.randomUUID();
const createdBotUserIds: string[] = [];
const owner: AuthUser = {
  id: ownerId,
  name: "Hermes MCP owner",
  email: "hermes-mcp-owner@example.com",
  avatar: null,
  type: "human",
};
const outsider: AuthUser = {
  id: outsiderId,
  name: "Hermes MCP outsider",
  email: "hermes-mcp-outsider@example.com",
  avatar: null,
  type: "human",
};

function parseSuccess(result: Awaited<ReturnType<RegisteredTool["handler"]>>) {
  expect(result.isError).not.toBe(true);
  expect(result.content[0]?.type).toBe("text");
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

beforeAll(async () => {
  registerTools(fakeServer as Parameters<typeof registerTools>[0]);
  await db.insert(users).values([
    {
      id: ownerId,
      name: owner.name,
      email: owner.email,
      emailVerified: true,
      type: "human",
    },
    {
      id: outsiderId,
      name: outsider.name,
      email: outsider.email,
      emailVerified: true,
      type: "human",
    },
  ]);
  await db.insert(workspaces).values({
    id: workspaceId,
    name: "Hermes MCP test workspace",
    createdById: ownerId,
  });
  await db.insert(workspaceMembers).values({
    workspaceId,
    userId: ownerId,
    role: "owner",
  });
});

afterAll(async () => {
  await db.delete(workspaces).where(inArray(workspaces.id, [workspaceId]));
  if (createdBotUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdBotUserIds));
  }
  await db.delete(users).where(inArray(users.id, [ownerId, outsiderId]));
});

describe("Hermes MCP management tools", () => {
  test("registers only the supported Hermes management surface", () => {
    expect([...tools.keys()].filter((name) => name.includes("hermes"))).toEqual([
      "create_hermes_bot",
      "get_hermes_bot_config",
      "update_hermes_bot_config",
      "test_hermes_bot",
      "get_hermes_bot_capabilities",
    ]);
    expect([...tools.keys()].some((name) => /database|admin|sql/i.test(name))).toBe(
      false,
    );
  });

  test("creates and manages a Hermes bot through service permission checks", async () => {
    const createTool = tools.get("create_hermes_bot")!;
    const createdResult = await createTool.handler(
      {
        name: "MCP Hermes",
        workspaceId,
        attachmentAccess: false,
      },
      { authInfo: owner },
    );
    const created = parseSuccess(createdResult);
    expect(created.kind).toBe("hermes");
    expect(created.apiKey).toBeString();
    expect(created.webhookSecret).toBeUndefined();
    expect(created.attachmentAccess).toBe(false);
    const botId = created.id as string;
    const botUserId = created.userId as string;
    createdBotUserIds.push(botUserId);

    const config = parseSuccess(
      await tools
        .get("get_hermes_bot_config")!
        .handler({ botId }, { authInfo: owner }),
    );
    expect(config).toMatchObject({ botId, defaultMode: "run" });

    const updated = parseSuccess(
      await tools.get("update_hermes_bot_config")!.handler(
        { botId, defaultMode: "response" },
        { authInfo: owner },
      ),
    );
    expect(updated).toMatchObject({ botId, defaultMode: "response" });

    const tested = parseSuccess(
      await tools
        .get("test_hermes_bot")!
        .handler({ botId }, { authInfo: owner }),
    );
    expect(tested.ok).toBe(true);
    expect(tested.platform).toBe("thechat");

    const capabilities = parseSuccess(
      await tools
        .get("get_hermes_bot_capabilities")!
        .handler({ botId }, { authInfo: owner }),
    );
    expect(capabilities).toMatchObject({
      platform: "thechat",
      directMessages: true,
      workspaceBots: true,
    });

    const forbidden = await tools
      .get("get_hermes_bot_config")!
      .handler({ botId }, { authInfo: outsider });
    expect(forbidden.isError).toBe(true);
    expect(forbidden.content[0]?.text).toContain("Only the bot owner");
  });

  test("does not let bots or unauthorized humans create Hermes bots", async () => {
    const createTool = tools.get("create_hermes_bot")!;
    const botResult = await createTool.handler(
      { name: "Nested bot", workspaceId },
      {
        authInfo: {
          ...owner,
          id: crypto.randomUUID(),
          type: "bot",
          email: null,
        },
      },
    );
    expect(botResult.isError).toBe(true);
    expect(botResult.content[0]?.text).toBe("Bots cannot create other bots");

    const outsiderResult = await createTool.handler(
      { name: "Unauthorized Hermes", workspaceId },
      { authInfo: outsider },
    );
    expect(outsiderResult.isError).toBe(true);
    expect(outsiderResult.content[0]?.text).toContain(
      "not a member of this workspace",
    );
  });
});
