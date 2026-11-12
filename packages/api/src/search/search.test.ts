import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { Elysia } from "elysia";
import { and, eq, inArray } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { db } from "../db";
import {
  bots,
  conversationThreads,
  messages,
  users,
  workspaceMembers,
  workspaces,
} from "../db/schema";
import { authRoutes } from "../auth";
import { workspaceRoutes } from "../workspaces";
import { inviteRoutes } from "../invites";
import { conversationRoutes } from "../conversations";
import { botRoutes } from "../bots";
import { mcpRoutes } from "../mcp";
import { searchRoutes } from ".";

const app = new Elysia()
  .use(authRoutes)
  .use(workspaceRoutes)
  .use(inviteRoutes)
  .use(conversationRoutes)
  .use(botRoutes)
  .use(searchRoutes)
  .use(mcpRoutes);

const createdEmails: string[] = [];
const createdWorkspaceIds: string[] = [];
const createdBotUserIds: string[] = [];
// A token no other test file's data can collide with.
const run = crypto.randomUUID().slice(0, 8);

async function req(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
  const text = await response.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* plain text */
  }
  return { status: response.status, body: json };
}

async function ok(method: string, path: string, body?: unknown, token?: string) {
  const res = await req(method, path, body, token);
  expect(res.status, `${method} ${path}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body;
}

async function register(name: string) {
  const email = `search-${crypto.randomUUID()}@example.invalid`;
  createdEmails.push(email);
  const body = await ok("POST", "/auth/register", { name, email, password: "password123" });
  return { token: body.accessToken as string, id: body.user.id as string, name };
}

async function join(workspaceId: string, owner: { token: string }, member: { token: string; id: string }) {
  const [inviteeEmail] = await db.select({ email: users.email }).from(users).where(eq(users.id, member.id));
  const invite = await ok("POST", "/invites/create", { workspaceId, email: inviteeEmail!.email }, owner.token);
  await ok("POST", "/invites/accept", { inviteId: invite.id }, member.token);
}

/** Insert a message at an exact time (search ordering depends on it). */
async function message(
  conversationId: string,
  senderId: string,
  content: string,
  options: { at?: Date; threadId?: string | null; interim?: boolean } = {},
) {
  const [row] = await db
    .insert(messages)
    .values({
      conversationId,
      senderId,
      content,
      threadId: options.threadId ?? null,
      interim: options.interim ?? false,
      ...(options.at ? { createdAt: options.at } : {}),
    })
    .returning({ id: messages.id });
  return row!.id;
}

function search(token: string, params: Record<string, string | number>) {
  const query = new URLSearchParams(
    Object.entries(params).map(([key, value]) => [key, String(value)]),
  );
  return req("GET", `/search/messages?${query}`, undefined, token);
}

let alice: Awaited<ReturnType<typeof register>>;
let bob: Awaited<ReturnType<typeof register>>;
let carol: Awaited<ReturnType<typeof register>>;
let workspaceId: string;
let otherWorkspaceId: string;
let generalId: string;
let aliceBobDmId: string;
let koda: { userId: string; botId: string; apiKey: string };
let kodaDmId: string;

beforeAll(async () => {
  alice = await register(`Alice ${run}`);
  bob = await register(`Bob ${run}`);
  carol = await register(`Carol ${run}`);

  const workspace = await ok("POST", "/workspaces/create", { name: `Search ${run}` }, alice.token);
  workspaceId = workspace.id;
  createdWorkspaceIds.push(workspaceId);
  await join(workspaceId, alice, bob);
  const detail = await ok("GET", `/workspaces/${workspaceId}`, undefined, alice.token);
  generalId = detail.channels[0].id;

  const other = await ok("POST", "/workspaces/create", { name: `Elsewhere ${run}` }, carol.token);
  otherWorkspaceId = other.id;
  createdWorkspaceIds.push(otherWorkspaceId);

  aliceBobDmId = (await ok("POST", "/conversations/dm", { workspaceId, otherUserId: bob.id }, alice.token)).id;

  const bot = await ok("POST", "/bots/create", { name: `Koda ${run}`, kind: "hermes", workspaceId }, alice.token);
  createdBotUserIds.push(bot.userId);
  koda = { userId: bot.userId, botId: bot.id, apiKey: bot.apiKey };
  kodaDmId = (await ok("POST", "/conversations/dm", { workspaceId, otherUserId: koda.userId }, alice.token)).id;
});

afterAll(async () => {
  if (createdWorkspaceIds.length) {
    await db.delete(workspaces).where(inArray(workspaces.id, createdWorkspaceIds));
  }
  if (createdBotUserIds.length) await db.delete(users).where(inArray(users.id, createdBotUserIds));
  if (createdEmails.length) await db.delete(users).where(inArray(users.email, createdEmails));
});

describe("message search", () => {
  test("finds only what each person can read, across workspaces", async () => {
    const word = `zephyr${run}`;
    await message(generalId, alice.id, `Channel note about ${word} rollout`);
    await message(aliceBobDmId, bob.id, `Private ${word} detail for Alice`);
    await message(kodaDmId, alice.id, `Ask Koda about ${word}`);
    const carolGeneral = (await ok("GET", `/workspaces/${otherWorkspaceId}`, undefined, carol.token)).channels[0].id;
    await message(carolGeneral, carol.id, `${word} in another company`);

    const forAlice = await search(alice.token, { q: word });
    expect(forAlice.status).toBe(200);
    expect(forAlice.body.results.map((hit: any) => hit.conversationId).sort()).toEqual(
      [generalId, aliceBobDmId, kodaDmId].sort(),
    );
    const dmHit = forAlice.body.results.find((hit: any) => hit.conversationId === aliceBobDmId);
    // The UI names a DM after the other person, and every hit says where it is.
    expect(dmHit).toMatchObject({
      conversationType: "direct",
      conversationName: bob.name,
      workspaceId,
      workspaceName: `Search ${run}`,
      senderName: bob.name,
      senderType: "human",
    });
    expect(dmHit.snippet).toContain(word);

    // Bob shares the channel and the DM, not Alice's DM with her agent.
    const forBob = await search(bob.token, { q: word });
    expect(forBob.body.results.map((hit: any) => hit.conversationId).sort()).toEqual(
      [generalId, aliceBobDmId].sort(),
    );
    // Carol sees only her own workspace.
    const forCarol = await search(carol.token, { q: word });
    expect(forCarol.body.results.map((hit: any) => hit.conversationId)).toEqual([carolGeneral]);
    // Naming a conversation you cannot read is a 404, not an empty list.
    expect((await search(carol.token, { q: word, conversationId: aliceBobDmId })).status).toBe(404);
  });

  test("a member removed from a workspace loses its history", async () => {
    const word = `quokka${run}`;
    await message(generalId, alice.id, `${word} launch plan`);
    expect((await search(bob.token, { q: word })).body.results).toHaveLength(1);

    // The participant row of the channel stays behind; membership is what counts.
    await db
      .delete(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, bob.id)));
    try {
      expect((await search(bob.token, { q: word })).body.results).toEqual([]);
      expect((await search(bob.token, { q: word, workspaceId })).body.results).toEqual([]);
    } finally {
      await db.insert(workspaceMembers).values({ workspaceId, userId: bob.id, role: "member" });
    }
  });

  test("all words must match, quotes keep a phrase, and wildcards are literal", async () => {
    const tag = `ibis${run}`;
    const both = await message(generalId, alice.id, `${tag} release notes are drafted`);
    await message(generalId, alice.id, `${tag} notes about the release are pending`);
    await message(generalId, alice.id, `${tag} 100% done`);
    await message(generalId, alice.id, `${tag} 1000 done`);
    await message(generalId, alice.id, `${tag} release progress`, { interim: true });

    const words = await search(alice.token, { q: `${tag} release notes` });
    expect(words.body.results).toHaveLength(2);
    const phrase = await search(alice.token, { q: `${tag} "release notes"` });
    expect(phrase.body.results.map((hit: any) => hit.id)).toEqual([both]);
    // `%` matches a percent sign, not "anything".
    const percent = await search(alice.token, { q: `${tag} 100%` });
    expect(percent.body.results).toHaveLength(1);
    expect(percent.body.results[0].snippet).toContain("100% done");
    // Agent progress updates are not search results.
    expect((await search(alice.token, { q: `${tag} progress` })).body.results).toEqual([]);
    // Matching ignores case.
    expect((await search(alice.token, { q: `${tag.toUpperCase()} DRAFTED` })).body.results).toHaveLength(1);
  });

  test("pages are complete and disjoint even when messages share a timestamp", async () => {
    const tag = `heron${run}`;
    const sameInstant = new Date("2026-10-01T12:00:00.123456Z");
    const ids = new Set<string>();
    for (let index = 0; index < 7; index += 1) {
      ids.add(await message(generalId, bob.id, `${tag} same instant ${index}`, { at: sameInstant }));
    }
    for (let index = 0; index < 4; index += 1) {
      ids.add(
        await message(generalId, bob.id, `${tag} later ${index}`, {
          at: new Date(Date.parse("2026-10-02T00:00:00Z") + index * 1000),
        }),
      );
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await search(alice.token, { q: tag, limit: 3, ...(cursor ? { cursor } : {}) });
      expect(page.status).toBe(200);
      seen.push(...page.body.results.map((hit: any) => hit.id));
      cursor = page.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    expect(pages).toBe(4);
    expect(new Set(seen).size).toBe(seen.length);
    expect(new Set(seen)).toEqual(ids);
    // Newest first.
    expect(seen.slice(0, 4)).toHaveLength(4);
    expect((await search(alice.token, { q: tag, cursor: "not-a-cursor" })).status).toBe(400);
  });

  test("filters narrow by sender, time and task", async () => {
    const tag = `marten${run}`;
    await message(generalId, alice.id, `${tag} from alice`, { at: new Date("2026-09-01T10:00:00Z") });
    await message(generalId, bob.id, `${tag} from bob`, { at: new Date("2026-09-02T10:00:00Z") });

    const fromBob = await search(alice.token, { q: tag, senderId: bob.id });
    expect(fromBob.body.results.map((hit: any) => hit.senderName)).toEqual([bob.name]);
    const before = await search(alice.token, { q: tag, before: "2026-09-02" });
    expect(before.body.results.map((hit: any) => hit.senderName)).toEqual([alice.name]);
    expect((await search(alice.token, { q: "x" })).status).toBe(400);
    expect((await search(alice.token, { q: tag, threadId: crypto.randomUUID() })).status).toBe(400);
  });
});

describe("quick switcher directory", () => {
  test("includes current human pictures without leaking another workspace's members", async () => {
    const avatar = "data:image/png;base64,cGljdHVyZQ==";
    await db.update(users).set({ avatar }).where(eq(users.id, bob.id));
    try {
      const directory = (await ok("GET", "/search/directory", undefined, alice.token)).destinations;
      expect(directory).toContainEqual(expect.objectContaining({ userId: bob.id, avatar }));
      const unrelated = (await ok("GET", "/search/directory", undefined, carol.token)).destinations;
      expect(unrelated.some((entry: any) => entry.userId === bob.id)).toBe(false);
    } finally {
      await db.update(users).set({ avatar: null }).where(eq(users.id, bob.id));
    }
  });

  test("lists channels, people with their DM, and recent Hermes tasks in all workspaces", async () => {
    const [task] = await db
      .insert(conversationThreads)
      .values({ conversationId: kodaDmId, botId: koda.botId, title: `Invoice cleanup ${run}`, createdById: alice.id })
      .returning({ id: conversationThreads.id });

    const directory = (await ok("GET", "/search/directory", undefined, alice.token)).destinations;
    expect(directory).toContainEqual(
      expect.objectContaining({ kind: "channel", conversationId: generalId, workspaceId }),
    );
    expect(directory).toContainEqual(
      expect.objectContaining({
        kind: "person",
        userId: koda.userId,
        userType: "bot",
        botKind: "hermes",
        conversationId: kodaDmId,
      }),
    );
    expect(directory).toContainEqual(
      expect.objectContaining({ kind: "person", userId: bob.id, conversationId: aliceBobDmId }),
    );
    expect(directory).toContainEqual(
      expect.objectContaining({ kind: "task", threadId: task!.id, conversationId: kodaDmId, conversationName: `Koda ${run}` }),
    );
    // Never yourself, never another company.
    expect(directory.some((entry: any) => entry.userId === alice.id)).toBe(false);
    expect(directory.some((entry: any) => entry.workspaceId === otherWorkspaceId)).toBe(false);

    // Bob is in the workspace but not in Alice's Koda DM: no task leaks.
    const forBob = (await ok("GET", "/search/directory", undefined, bob.token)).destinations;
    expect(forBob.some((entry: any) => entry.kind === "task" && entry.threadId === task!.id)).toBe(false);
    expect(forBob).toContainEqual(expect.objectContaining({ kind: "person", userId: koda.userId, conversationId: null }));
  });

  test("destinations resolve a loose name to the best match", async () => {
    const found = await ok(
      "GET",
      `/search/destinations?q=${encodeURIComponent(`kda ${run}`.replace(" ", ""))}&kinds=person`,
      undefined,
      alice.token,
    );
    expect(found.destinations[0]).toMatchObject({ kind: "person", userId: koda.userId });
    expect((await req("GET", "/search/destinations?q=a&kinds=bogus", undefined, alice.token)).status).toBe(400);
  });
});

describe("message context", () => {
  test("shows the target inside the scope the app shows it", async () => {
    const [taskA, taskB] = await db
      .insert(conversationThreads)
      .values([
        { conversationId: kodaDmId, botId: koda.botId, title: `Task A ${run}`, createdById: alice.id },
        { conversationId: kodaDmId, botId: koda.botId, title: `Task B ${run}`, createdById: alice.id },
      ])
      .returning({ id: conversationThreads.id });
    const base = Date.parse("2026-08-01T09:00:00Z");
    const ids: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      ids.push(
        await message(kodaDmId, index % 2 ? koda.userId : alice.id, `task a step ${index}`, {
          threadId: taskA!.id,
          at: new Date(base + index * 60_000),
        }),
      );
      // Interleaved noise in another task and in General.
      await message(kodaDmId, alice.id, `task b noise ${index}`, { threadId: taskB!.id, at: new Date(base + index * 60_000 + 1) });
      await message(kodaDmId, alice.id, `general noise ${index}`, { at: new Date(base + index * 60_000 + 2) });
    }

    const context = await ok("GET", `/search/messages/${ids[3]}/context?before=2&after=1`, undefined, alice.token);
    expect(context.threadId).toBe(taskA!.id);
    expect(context.threadTitle).toBe(`Task A ${run}`);
    expect(context.targetMessageId).toBe(ids[3]);
    expect(context.messages.map((item: any) => item.id)).toEqual([ids[1], ids[2], ids[3], ids[4]]);
    expect(context.hasOlder).toBe(true);
    expect(context.hasNewer).toBe(true);
    expect(context.conversation).toMatchObject({ id: kodaDmId, type: "direct", name: `Koda ${run}` });

    // Unknown and unreadable look the same.
    expect((await req("GET", `/search/messages/${ids[3]}/context`, undefined, bob.token)).status).toBe(404);
    expect((await req("GET", `/search/messages/${crypto.randomUUID()}/context`, undefined, alice.token)).status).toBe(404);
  });

  test("a channel's context is the whole channel", async () => {
    const base = Date.parse("2026-07-01T09:00:00Z");
    const first = await message(generalId, alice.id, `ctx first ${run}`, { at: new Date(base) });
    const second = await message(generalId, bob.id, `ctx second ${run}`, { at: new Date(base + 1000) });
    const context = await ok("GET", `/search/messages/${second}/context?before=1&after=0`, undefined, bob.token);
    expect(context.threadId).toBeNull();
    expect(context.messages.map((item: any) => item.id)).toEqual([first, second]);
  });
});

describe("MCP search tools", () => {
  test("an agent finds a conversation, searches it, and reads around a hit", async () => {
    // A bot sees what it takes part in: here the workspace's channels.
    const fact = `The staging password rotates every Tuesday ${run}`;
    const factId = await message(generalId, bob.id, fact);
    await message(generalId, alice.id, `Thanks, noted ${run}`, { at: new Date(Date.now() + 1000) });

    const client = new Client({ name: "search-test-agent", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      requestInit: { headers: { authorization: `Bearer ${koda.apiKey}` } },
      fetch: (input, init) => app.handle(new Request(input, init)),
    });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      for (const name of ["search_messages", "get_message_context", "find_conversations"]) {
        expect(byName.get(name)?.annotations?.readOnlyHint).toBe(true);
      }

      const call = async (name: string, args: Record<string, unknown>) => {
        const result = (await client.callTool({ name, arguments: args })) as {
          content: Array<{ type: string; text: string }>;
          isError?: boolean;
        };
        expect(result.isError, result.content[0]?.text).not.toBe(true);
        return JSON.parse(result.content[0]!.text);
      };

      const found = await call("find_conversations", { query: "general", kinds: ["channel"], workspaceId });
      expect(found.destinations[0]).toMatchObject({ kind: "channel", conversationId: generalId });

      const hits = await call("search_messages", {
        query: `"staging password" ${run}`,
        conversationId: found.destinations[0].conversationId,
      });
      expect(hits.results.map((hit: any) => hit.id)).toEqual([factId]);

      const context = await call("get_message_context", { messageId: factId, before: 0, after: 1 });
      expect(context.messages.map((item: any) => item.content)).toEqual([fact, `Thanks, noted ${run}`]);

      // The agent's own scope still applies: Alice's DM with Bob is invisible.
      const privateHit = await message(aliceBobDmId, alice.id, `bob-only secret ${run}`);
      const none = await call("search_messages", { query: `bob-only secret ${run}` });
      expect(none.results).toEqual([]);
      const denied = (await client.callTool({
        name: "get_message_context",
        arguments: { messageId: privateHit },
      })) as { isError?: boolean };
      expect(denied.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
