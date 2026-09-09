import { afterAll, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { attachments, messageAttachments, messageReactions, bots, conversationParticipants, conversations, conversationThreads, messages, session, users, workspaceMembers, workspaces } from "../db/schema";

import { searchRoutes } from "./index";
const app = new Elysia().use(searchRoutes);
const userIds: string[] = [];
const workspaceIds: string[] = [];
async function get(path: string, token?: string, extra: Record<string, string> = {}) {
  const response = await app.handle(new Request(`http://localhost${path}`, {
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
  }));
  const text = await response.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* Keep framework errors visible. */ }
  return { status: response.status, body };
}
async function human(name = "Search Human") {
  const [user] = await db.insert(users).values({ name, email: `search-${crypto.randomUUID()}@test.com`, emailVerified: true }).returning();
  userIds.push(user.id);
  const token = crypto.randomUUID();
  await db.insert(session).values({ id: crypto.randomUUID(), userId: user.id, token, expiresAt: new Date(Date.now() + 3600_000) });
  return { ...user, token };
}
async function workspace(ownerId: string, memberIds: string[] = [], name = "Search Workspace") {
  const id = `search-${crypto.randomUUID()}`;
  await db.insert(workspaces).values({ id, name, createdById: ownerId });
  workspaceIds.push(id);
  await db.insert(workspaceMembers).values([...new Set([ownerId, ...memberIds])].map(userId => ({ workspaceId: id, userId })));
  return id;
}
async function conversation(workspaceId: string, memberIds: string[], title: string, type: "direct" | "group" = "group", updatedAt = new Date()) {
  const [row] = await db.insert(conversations).values({ workspaceId, title, name: type === "group" ? crypto.randomUUID() : null, type, updatedAt }).returning();
  await db.insert(conversationParticipants).values(memberIds.map(userId => ({ conversationId: row.id, userId })));
  return row;
}
afterAll(async () => {
  if (workspaceIds.length) await db.delete(workspaces).where(inArray(workspaces.id, workspaceIds));
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
});

test("jump requires authentication", async () => {
  expect((await get("/search/jump")).status).toBe(401);
});

test("jump discovers only current memberships and participation across every workspace", async () => {
  const alice = await human("Alice"), bob = await human("Bob"), eve = await human("Eve");
  const alpha = await workspace(alice.id, [bob.id, eve.id], "Alpha");
  const beta = await workspace(alice.id, [bob.id], "Beta");
  const departed = await workspace(bob.id, [alice.id], "Departed");
  const channel = await conversation(alpha, [alice.id, bob.id], "Design");
  const dm = await conversation(beta, [alice.id, bob.id], "Do not display DM storage title", "direct");
  await conversation(alpha, [bob.id, eve.id], "Private", "direct");
  await conversation(alpha, [bob.id], "Unjoined");
  await conversation(departed, [alice.id, bob.id], "Old DM", "direct");
  await db.delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, departed), eq(workspaceMembers.userId, alice.id)));
  const result = await get(`/search/jump?workspaceId=${alpha}`, alice.token);
  expect(result.status).toBe(200);
  expect(result.body.hasMore).toBe(false);
  expect(result.body.items).toHaveLength(2);
  expect(result.body.items).toEqual(expect.arrayContaining([
    { id: `channel:${channel.id}`, kind: "channel", conversationId: channel.id, conversationType: "group", threadId: null, workspaceId: alpha, workspaceName: "Alpha", title: "Design", conversationName: "Design", participantType: null, updatedAt: channel.updatedAt.toISOString() },
    { id: `dm:${dm.id}`, kind: "dm", conversationId: dm.id, conversationType: "direct", threadId: null, workspaceId: beta, workspaceName: "Beta", title: "Bob", conversationName: "Bob", participantType: "human", updatedAt: dm.updatedAt.toISOString() },
  ]));
});

test("jump fails closed on legacy DMs with extra participants", async () => {
  const alice = await human("Alice"), bob = await human("Bob"), eve = await human("Eve");
  const ws = await workspace(alice.id, [bob.id, eve.id]);
  await conversation(ws, [alice.id, bob.id, eve.id], "Corrupted DM", "direct");
  expect((await get("/search/jump", eve.token)).body).toEqual({ items: [], hasMore: false });
});

async function task(conversationId: string, ownerId: string, title: string) {
  const [botUser] = await db.insert(users).values({ name: "Task Bot", type: "bot" }).returning();
  userIds.push(botUser.id);
  const [bot] = await db.insert(bots).values({ userId: botUser.id, ownerId, webhookSecret: "synthetic", kind: "hermes" }).returning();
  const [thread] = await db.insert(conversationThreads).values({ conversationId, botId: bot.id, createdById: ownerId, title }).returning();
  return thread;
}

test("jump exposes tasks with stable thread IDs and parent names", async () => {
  const alice = await human(), bob = await human();
  const ws = await workspace(alice.id, [bob.id]);
  const channel = await conversation(ws, [alice.id], "Engineering");
  const thread = await task(channel.id, alice.id, "Ship search");
  const hidden = await conversation(ws, [bob.id], "Hidden");
  await task(hidden.id, bob.id, "Private task");
  const result = await get("/search/jump?kind=task", alice.token);
  expect(result.body.items).toEqual([{
    id: `task:${thread.id}`, kind: "task", conversationId: channel.id, conversationType: "group", threadId: thread.id,
    workspaceId: ws, workspaceName: "Search Workspace", title: "Ship search", conversationName: "Engineering",
    participantType: null, updatedAt: thread.lastActivityAt.toISOString(),
  }]);
});

test("jump ranks exact, prefix, substring and subsequence names before workspace recency", async () => {
  const alice = await human();
  const active = await workspace(alice.id), other = await workspace(alice.id);
  const recent = new Date("2026-05-01T00:00:00Z"), older = new Date("2026-01-01T00:00:00Z");
  const fuzzy = await conversation(active, [alice.id], "Silly elephants always read code happily", "group", recent);
  const substring = await conversation(active, [alice.id], "Global Search", "group", recent);
  const prefix = await conversation(active, [alice.id], "Search team", "group", recent);
  const exactOther = await conversation(other, [alice.id], "SEARCH", "group", recent);
  const exactActive = await conversation(active, [alice.id], "Search", "group", older);
  await conversation(active, [alice.id], "Unrelated", "group", recent);
  const parentTask = await task(prefix.id, alice.id, "Fix pagination");
  const result = await get(`/search/jump?q=search&workspaceId=${active}`, alice.token);
  expect(result.body.items.map((i: any) => i.id)).toEqual([exactActive, exactOther, prefix, substring, fuzzy].map(c => `channel:${c.id}`).concat(`task:${parentTask.id}`));
  expect((await get("/search/jump?q=absent", alice.token)).body).toEqual({ items: [], hasMore: false });
});

test("jump paginates stable recent destinations with truthful hasMore", async () => {
  const alice = await human();
  const ws = await workspace(alice.id);
  const rows = await db.insert(conversations).values(Array.from({ length: 33 }, (_, i) => ({ workspaceId: ws, type: "group" as const, title: `Channel ${i}`, updatedAt: new Date("2026-02-01T00:00:00Z") }))).returning();
  await db.insert(conversationParticipants).values(rows.map(c => ({ conversationId: c.id, userId: alice.id })));
  const ids = rows.map(c => `channel:${c.id}`).sort();
  const first = await get("/search/jump", alice.token);
  expect(first.body.items.map((i: any) => i.id)).toEqual(ids.slice(0, 30));
  expect(first.body.hasMore).toBe(true);
  const last = await get("/search/jump?limit=3&offset=30", alice.token);
  expect(last.body.items.map((i: any) => i.id)).toEqual(ids.slice(30));
  expect(last.body.hasMore).toBe(false);
  expect((await get("/search/jump?offset=33", alice.token)).body).toEqual({ items: [], hasMore: false });
  const newer = await conversation(ws, [alice.id], "Most recent", "group", new Date("2026-03-01T00:00:00Z"));
  expect((await get("/search/jump?limit=1", alice.token)).body.items[0].id).toBe(`channel:${newer.id}`);
});

test("jump rejects malformed or unbounded queries instead of widening scope", async () => {
  const alice = await human();
  for (const query of ["limit=0", "limit=51", "limit=-1", "limit=1.5", "limit=1e2", "limit=no", "offset=-1", "offset=10001", "offset=1.5", "kind=private", "workspaceId=", `workspaceId=${"x".repeat(101)}`, `q=${"x".repeat(201)}`, "q=%00", "q=a&q=b", "limit=1&limit=2"]) {
    const result = await get(`/search/jump?${query}`, alice.token);
    expect({ query, status: result.status }).toEqual({ query, status: 400 });
    expect(result.body).toEqual({ error: "Invalid search query" });
  }
});

test("search rejects valid bot identities as a human-only UI", async () => {
  const alice = await human();
  const [botUser] = await db.insert(users).values({ name: "Search Bot", type: "bot" }).returning();
  userIds.push(botUser.id);
  await db.insert(bots).values({ userId: botUser.id, ownerId: alice.id, webhookSecret: "synthetic" });
  const { createBotApiKey } = await import("../auth/bot-api-keys");
  const token = await createBotApiKey(botUser.id);
  expect((await get("/search/jump", token)).status).toBe(403);
});

async function message(conversationId: string, senderId: string, content: string, threadId: string | null = null) {
  const [row] = await db.insert(messages).values({ conversationId, senderId, content, threadId }).returning();
  return row;
}

test("messages search spans authorized workspaces and tasks without leaking hidden scopes or parts", async () => {
  const alice = await human("Alice"), bob = await human("Bob"), eve = await human("Eve");
  const alpha = await workspace(alice.id, [bob.id, eve.id], "Alpha");
  const beta = await workspace(alice.id, [bob.id], "Beta");
  const departed = await workspace(bob.id, [alice.id]);
  const channel = await conversation(alpha, [alice.id, bob.id], "Engineering");
  const dm = await conversation(beta, [alice.id, bob.id], "Storage title", "direct");
  const thread = await task(channel.id, alice.id, "Search task");
  const ordinary = await message(dm.id, alice.id, "Needle own outgoing message");
  const taskMessage = await message(channel.id, bob.id, "Needle task reply", thread.id);
  for (const [ws, members, type] of [
    [alpha, [bob.id, eve.id], "direct"], [alpha, [alice.id, bob.id, eve.id], "direct"],
    [alpha, [bob.id], "group"], [departed, [alice.id, bob.id], "direct"],
  ] as const) {
    const c = await conversation(ws, [...members], "Hidden", type);
    await message(c.id, bob.id, "Needle forbidden content");
  }
  await db.delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, departed), eq(workspaceMembers.userId, alice.id)));
  await db.insert(messages).values({ conversationId: channel.id, senderId: bob.id, content: "Ordinary visible reply", parts: [{ type: "reasoning", text: "needle private thinking" }, { type: "tool-result", toolCallId: "x", toolName: "shell", result: "needle tool secret" }] });
  const response = await get("/search/messages?q=needle", alice.token);
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ hasMore: false, items: [
    { id: taskMessage.id, conversationId: channel.id, threadId: thread.id, workspaceId: alpha, workspaceName: "Alpha", conversationName: "Engineering", conversationType: "group", threadTitle: "Search task", senderName: "Bob", senderType: "human", content: "Needle task reply", createdAt: taskMessage.createdAt.toISOString() },
    { id: ordinary.id, conversationId: dm.id, threadId: null, workspaceId: beta, workspaceName: "Beta", conversationName: "Bob", conversationType: "direct", threadTitle: null, senderName: "Alice", senderType: "human", content: "Needle own outgoing message", createdAt: ordinary.createdAt.toISOString() },
  ] });
  expect((await get("/search/messages?q=needle")).status).toBe(401);
});

test("message search returns bounded snippets centered on a distant literal match", async () => {
  const alice = await human();
  const ws = await workspace(alice.id);
  const c = await conversation(ws, [alice.id], "Snippet");
  await message(c.id, alice.id, "before ".repeat(500) + "Needle **match**" + " after".repeat(500));
  const result = await get("/search/messages?q=needle", alice.token);
  expect(result.body.items[0].content.length).toBeLessThanOrEqual(320);
  expect(result.body.items[0].content).toContain("Needle");
  expect(result.body.items[0].content).toStartWith("…");
  expect(result.body.items[0].content).toEndWith("…");
  expect(result.body.items[0]).not.toHaveProperty("parts");
});

test("messages paginates all matches deterministically with a 20-result default", async () => {
  const alice = await human();
  const ws = await workspace(alice.id);
  const c = await conversation(ws, [alice.id], "Paged messages");
  const rows = await db.insert(messages).values(Array.from({ length: 23 }, () => ({ conversationId: c.id, senderId: alice.id, content: "needle", createdAt: new Date("2026-01-01T00:00:00Z") }))).returning();
  const ids = rows.map(m => m.id).sort().reverse();
  const first = await get("/search/messages?q=needle", alice.token);
  expect(first.body.items.map((i: any) => i.id)).toEqual(ids.slice(0, 20));
  expect(first.body.hasMore).toBe(true);
  const last = await get("/search/messages?q=needle&limit=3&offset=20", alice.token);
  expect(last.body.items.map((i: any) => i.id)).toEqual(ids.slice(20));
  expect(last.body.hasMore).toBe(false);
});

test("message search rejects blank, malformed and oversized queries", async () => {
  const alice = await human();
  for (const query of ["", "q=", "q=%20", "q=%00", `q=${"x".repeat(201)}`, "q=a&limit=0", "q=a&limit=51", "q=a&limit=no", "q=a&offset=-1", "q=a&offset=10001", "q=a&offset=1.5", "q=a&q=b"]) {
    const result = await get(`/search/messages?${query}`, alice.token);
    expect({ query, status: result.status }).toEqual({ query, status: 400 });
    expect(result.body).toEqual({ error: "Invalid search query" });
  }
});

test("context centers an old task message beyond the initial 120-message window", async () => {
  const alice = await human("Alice");
  const ws = await workspace(alice.id);
  const c = await conversation(ws, [alice.id], "Context");
  const thread = await task(c.id, alice.id, "Old task");
  const rows = await db.insert(messages).values(Array.from({ length: 170 }, (_, i) => ({ conversationId: c.id, senderId: alice.id, threadId: thread.id, content: `Message ${i}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) }))).returning();
  await message(c.id, alice.id, "Unthreaded must not bleed into task");
  const otherThread = await task(c.id, alice.id, "Another task");
  await message(c.id, alice.id, "Other task must not bleed", otherThread.id);
  const result = await get(`/search/messages/${rows[25].id}/context`, alice.token);
  expect(result.status).toBe(200);
  expect(result.body.conversationId).toBe(c.id);
  expect(result.body.threadId).toBe(thread.id);
  expect(result.body.hasOlder).toBe(true);
  expect(result.body.hasNewer).toBe(true);
  expect(result.body.messages.map((m: any) => m.id)).toEqual(rows.slice(5, 46).map(m => m.id));
  expect(result.body.messages[20]).toMatchObject({ id: rows[25].id, senderName: "Alice", senderType: "human", content: "Message 25", createdAt: rows[25].createdAt.toISOString() });
});

test("context returns the same 404 for absent, unauthorized, departed and malformed targets", async () => {
  const alice = await human(), bob = await human(), eve = await human();
  const ws = await workspace(bob.id, [alice.id, eve.id]);
  const outsiderDm = await conversation(ws, [bob.id, eve.id], "Private DM", "direct");
  const corruptDm = await conversation(ws, [alice.id, bob.id, eve.id], "Corrupt DM", "direct");
  const removedDm = await conversation(ws, [alice.id, bob.id], "Departed DM", "direct");
  const channel = await conversation(ws, [bob.id], "Unjoined channel");
  const ids: string[] = [];
  for (const c of [outsiderDm, corruptDm, removedDm, channel]) ids.push((await message(c.id, bob.id, "private content")).id);
  await db.delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, ws), eq(workspaceMembers.userId, alice.id)));
  ids.push(crypto.randomUUID(), "not-a-uuid");
  for (const id of ids) {
    const result = await get(`/search/messages/${id}/context`, alice.token);
    expect(result).toEqual({ status: 404, body: { error: "Message not found" } });
  }
  expect((await get(`/search/messages/${ids[0]}/context`)).status).toBe(401);
});

async function attachment(conversationId: string, uploaderId: string, messageId: string, position = 0) {
  const [row] = await db.insert(attachments).values({ conversationId, uploaderId, fileName: "notes.txt", declaredMediaType: "text/plain", declaredSizeBytes: 10, declaredChecksumSha256: "0".repeat(64), quarantineKey: "private-quarantine-key", cleanKey: "private-clean-key", status: "attached", uploadExpiresAt: new Date(), expiresAt: new Date() }).returning();
  await db.insert(messageAttachments).values({ messageId, attachmentId: row.id, position });
  return row;
}

test("context preserves ordinary public attachment and reaction DTOs without internal parts", async () => {
  const alice = await human("Alice"), bob = await human("Bob");
  const ws = await workspace(alice.id, [bob.id]);
  const c = await conversation(ws, [alice.id, bob.id], "Attachments");
  const m = await message(c.id, bob.id, "Visible text");
  await db.update(messages).set({ parts: [{ type: "reasoning", text: "NEVER EXPOSE" }, { type: "tool-result", toolCallId: "x", toolName: "read", result: "PRIVATE TOOL RESULT" }] }).where(eq(messages.id, m.id));
  await attachment(c.id, bob.id, m.id);
  await db.insert(messageReactions).values({ messageId: m.id, userId: alice.id, emoji: "👍" });
  const { getMessages } = await import("../services/messages");
  const ordinary = (await getMessages(c.id, alice.id))[0];
  const result = await get(`/search/messages/${m.id}/context`, alice.token);
  expect(result.body.messages[0].attachments).toEqual(ordinary.attachments);
  expect(result.body.messages[0].reactions).toEqual(ordinary.reactions);
  expect(JSON.stringify(result.body)).not.toContain("private-clean-key");
  expect(JSON.stringify(result.body)).not.toContain("private-quarantine-key");
  expect(JSON.stringify(result.body)).not.toContain("NEVER EXPOSE");
  expect(JSON.stringify(result.body)).not.toContain("PRIVATE TOOL RESULT");
  expect(result.body.hasOlder).toBe(false);
  expect(result.body.hasNewer).toBe(false);
});

test("context suppresses a corrupt attachment link to an inaccessible conversation", async () => {
  const alice = await human(), bob = await human(), eve = await human();
  const ws = await workspace(alice.id, [bob.id, eve.id]);
  const visible = await conversation(ws, [alice.id], "Visible");
  const hidden = await conversation(ws, [bob.id, eve.id], "Private DM", "direct");
  const m = await message(visible.id, alice.id, "Public message");
  const foreign = await attachment(hidden.id, bob.id, m.id);
  const result = await get(`/search/messages/${m.id}/context`, alice.token);
  expect(result.body.messages[0].attachments).toEqual([]);
  expect(JSON.stringify(result.body)).not.toContain(foreign.id);
});

test("database migration provides substring search and deterministic context indexes", async () => {
  const { sql } = await import("drizzle-orm");
  const indexes = await db.execute(sql`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('messages_content_search_idx', 'messages_context_order_idx') ORDER BY indexname`);
  expect(indexes).toHaveLength(2);
  expect(indexes.find(i => i.indexname === "messages_content_search_idx")!.indexdef).toContain("gin");
  expect(indexes.find(i => i.indexname === "messages_content_search_idx")!.indexdef).toContain("gin_trgm_ops");
  expect(indexes.find(i => i.indexname === "messages_context_order_idx")!.indexdef).toContain("conversation_id, thread_id, created_at, id");
});

// Regression checks on the shared authorization, literal matching and tuple ordering.
test("literal punctuation is never interpreted as SQL, LIKE wildcards or query operators", async () => {
  const alice = await human();
  const ws = await workspace(alice.id);
  const literal = String.raw`100%_\';--`;
  const c = await conversation(ws, [alice.id], literal);
  const m = await message(c.id, alice.id, literal);
  const other = await conversation(ws, [alice.id], "100 unrelated");
  await message(other.id, alice.id, "100 unrelated");
  for (const q of [literal, "%", "_", "\\", "';--"]) {
    expect((await get(`/search/jump?q=${encodeURIComponent(q)}`, alice.token)).body.items.map((i: any) => i.id)).toEqual([`channel:${c.id}`]);
    expect((await get(`/search/messages?q=${encodeURIComponent(q)}`, alice.token)).body.items.map((i: any) => i.id)).toEqual([m.id]);
  }
  await message(c.id, alice.id, "red blue");
  await message(c.id, alice.id, "blue red");
  expect((await get("/search/messages?q=red%20blue", alice.token)).body.items.map((i: any) => i.content)).toEqual(["red blue"]);
});

test("trusted browser cookies authorize every search endpoint without bearer tokens", async () => {
  const alice = await human();
  const ws = await workspace(alice.id);
  const c = await conversation(ws, [alice.id], "Cookie channel");
  const m = await message(c.id, alice.id, "cookie message");
  const previousOrigins = process.env.THECHAT_WEB_ORIGINS, previousBackend = process.env.BETTER_AUTH_URL;
  process.env.THECHAT_WEB_ORIGINS = "https://search.example.test";
  process.env.BETTER_AUTH_URL = "https://api.example.test";
  try {
    const headers = { "x-thechat-client": "web", origin: "https://search.example.test", cookie: `__Host-thechat_session=${alice.token}` };
    for (const path of ["/search/jump", "/search/messages?q=cookie", `/search/messages/${m.id}/context`]) {
      expect((await get(path, undefined, headers)).status).toBe(200);
      expect((await get(path, undefined, { ...headers, origin: "https://evil.example.test" })).status).toBe(403);
    }
  } finally {
    if (previousOrigins === undefined) delete process.env.THECHAT_WEB_ORIGINS; else process.env.THECHAT_WEB_ORIGINS = previousOrigins;
    if (previousBackend === undefined) delete process.env.BETTER_AUTH_URL; else process.env.BETTER_AUTH_URL = previousBackend;
  }
});

test("context orders equal timestamps by UUID with exact boundary flags", async () => {
  const alice = await human();
  const ws = await workspace(alice.id);
  const c = await conversation(ws, [alice.id], "Ties");
  const rows = await db.insert(messages).values(Array.from({ length: 45 }, (_, i) => ({ conversationId: c.id, senderId: alice.id, content: `Equal timestamp ${i}`, createdAt: new Date("2026-01-01T00:00:00Z") }))).returning();
  const ids = rows.map(m => m.id).sort();
  for (const [index, start, end, hasOlder, hasNewer] of [[0, 0, 21, false, true], [22, 2, 43, true, true], [44, 24, 45, true, false]] as const) {
    const result = await get(`/search/messages/${ids[index]}/context`, alice.token);
    expect(result.body.messages.map((m: any) => m.id)).toEqual(ids.slice(start, end));
    expect(result.body.hasOlder).toBe(hasOlder);
    expect(result.body.hasNewer).toBe(hasNewer);
    expect(result.body.threadId).toBeNull();
  }
});

test("all endpoints recheck participation and reject cross-conversation thread corruption", async () => {
  const alice = await human(), bob = await human();
  const ws = await workspace(alice.id, [bob.id]);
  const visible = await conversation(ws, [alice.id], "Visible");
  const hidden = await conversation(ws, [bob.id], "Private parent");
  const thread = await task(hidden.id, bob.id, "Private thread title");
  const corrupt = await message(visible.id, alice.id, "needle corrupt thread", thread.id);
  expect((await get("/search/messages?q=needle", alice.token)).body.items).toEqual([]);
  expect((await get(`/search/messages/${corrupt.id}/context`, alice.token)).status).toBe(404);
  const m = await message(visible.id, alice.id, "needle valid");
  expect((await get(`/search/messages/${m.id}/context`, alice.token)).status).toBe(200);
  await db.delete(conversationParticipants).where(and(eq(conversationParticipants.conversationId, visible.id), eq(conversationParticipants.userId, alice.id)));
  expect((await get("/search/jump", alice.token)).body.items).toEqual([]);
  expect((await get("/search/messages?q=needle", alice.token)).body.items).toEqual([]);
  expect((await get(`/search/messages/${m.id}/context`, alice.token)).status).toBe(404);
});

test("context does not expose attachment metadata after the attachment is deleted", async () => {
  const alice = await human();
  const ws = await workspace(alice.id);
  const c = await conversation(ws, [alice.id], "Deleted attachment");
  const m = await message(c.id, alice.id, "Message remains");
  const file = await attachment(c.id, alice.id, m.id);
  await db.update(attachments).set({ status: "deleted" }).where(eq(attachments.id, file.id));
  const result = await get(`/search/messages/${m.id}/context`, alice.token);
  expect(result.body.messages[0].attachments).toEqual([]);
});

test("empty jump ranks old visited IDs before LIMIT without granting access or changing text ranking", async () => {
  const alice = await human(), bob = await human();
  const ws = await workspace(alice.id, [bob.id]);
  const old = await conversation(ws, [alice.id], "Visited ancient", "group", new Date("2025-01-01T00:00:00Z"));
  const hidden = await conversation(ws, [bob.id], "Forbidden visited", "group", new Date("2025-01-01T00:00:00Z"));
  const rows = await db.insert(conversations).values(Array.from({ length: 31 }, () => ({ workspaceId: ws, type: "group" as const, title: "Recent destination", updatedAt: new Date("2026-01-01T00:00:00Z") }))).returning();
  await db.insert(conversationParticipants).values(rows.map(c => ({ conversationId: c.id, userId: alice.id })));
  const recentIds = encodeURIComponent([`channel:${hidden.id}`, `channel:${old.id}`].join(","));
  const result = await get(`/search/jump?recentIds=${recentIds}`, alice.token);
  expect(result.status).toBe(200);
  expect(result.body.items).toHaveLength(30);
  expect(result.body.items[0].id).toBe(`channel:${old.id}`);
  expect(result.body.items.some((i: any) => i.conversationId === hidden.id)).toBe(false);
  expect(result.body.hasMore).toBe(true);
  const matches = await get(`/search/jump?q=recent&recentIds=${recentIds}`, alice.token);
  expect(matches.body.items.some((i: any) => i.conversationId === old.id)).toBe(false);
});

test("recent ID hints are bounded and validate exact destination identities", async () => {
  const alice = await human();
  const valid = `dm:${crypto.randomUUID()}`;
  for (const recentIds of ["dm:not-a-uuid", `other:${crypto.randomUUID()}`, "x".repeat(1601), Array.from({ length: 31 }, () => `channel:${crypto.randomUUID()}`).join(","), `${valid},`, `${valid},${valid}`]) {
    expect((await get(`/search/jump?recentIds=${encodeURIComponent(recentIds)}`, alice.token)).status).toBe(400);
  }
  expect((await get("/search/jump?recentIds=", alice.token)).status).toBe(200);
  expect((await get(`/search/jump?recentIds=${Array.from({ length: 30 }, () => `task:${crypto.randomUUID()}`).join(",")}`, alice.token)).status).toBe(200);
});

test.each(["jump", "messages"])("%s stops at the total result cap and distinguishes actual truncation", async (endpoint) => {
  const alice = await human();
  const ws = await workspace(alice.id);
  let removeExtra: () => Promise<unknown>;
  if (endpoint === "jump") {
    await db.execute(sql`WITH inserted AS (
      INSERT INTO conversations (workspace_id, type, title)
      SELECT ${ws}, ${"group"}::conversation_type, ${"capneedle"} FROM generate_series(1, 10000)
      RETURNING id
    ) INSERT INTO conversation_participants (conversation_id, user_id)
      SELECT id, ${alice.id}::uuid FROM inserted`);
    const extra = await conversation(ws, [alice.id], "capneedle");
    removeExtra = () => db.delete(conversations).where(eq(conversations.id, extra.id));
  } else {
    const c = await conversation(ws, [alice.id], "Cap messages");
    await db.execute(sql`INSERT INTO messages (conversation_id, sender_id, content)
      SELECT ${c.id}::uuid, ${alice.id}::uuid, ${"capneedle"} FROM generate_series(1, 10000)`);
    const extra = await message(c.id, alice.id, "capneedle");
    removeExtra = () => db.delete(messages).where(eq(messages.id, extra.id));
  }
  for (const truncated of [true, false]) {
    const before = await get(`/search/${endpoint}?q=capneedle&limit=30&offset=9960`, alice.token);
    expect(before.status).toBe(200);
    expect(before.body.items).toHaveLength(30);
    expect(before.body.hasMore).toBe(true);
    const last = await get(`/search/${endpoint}?q=capneedle&limit=30&offset=9990`, alice.token);
    expect(last.status).toBe(200);
    expect(last.body.items).toHaveLength(10);
    expect(last.body.hasMore).toBe(false);
    expect(last.body.truncated).toBe(truncated);
    const cap = await get(`/search/${endpoint}?q=capneedle&offset=10000`, alice.token);
    expect(cap.status).toBe(200);
    expect(cap.body).toEqual({ items: [], hasMore: false, truncated });
    if (truncated) await removeExtra();
  }
  expect((await get(`/search/${endpoint}?q=capneedle&offset=10001`, alice.token)).status).toBe(400);
});
