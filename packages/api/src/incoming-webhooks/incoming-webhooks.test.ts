import { afterAll, beforeAll, expect, test } from "bun:test";
import crypto from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { Elysia } from "elysia";
import { authRoutes } from "../auth";
import { workspaceRoutes } from "../workspaces";
import { messageRoutes } from "../messages";
import { conversationRoutes } from "../conversations";
import { incomingWebhookRoutes } from ".";
import { db } from "../db";
import { incomingWebhooks, messages, messageUnreads, users, workspaces, workspaceMembers } from "../db/schema";
import { queueJobs } from "../async/job-schema";
import { LocalRealtimeBus, setRealtimeBusForTests, closeRealtimeBusForTests, type RealtimeEvent } from "../realtime";

const app = new Elysia().use(authRoutes).use(workspaceRoutes).use(conversationRoutes).use(messageRoutes).use(incomingWebhookRoutes);
const userIds: string[] = [];
const workspaceIds: string[] = [];
const events: RealtimeEvent[] = [];
let owner: { accessToken: string; user: { id: string } };
let channelId: string;
let workspaceId: string;
async function req(method: string, path: string, body?: unknown, token?: string) {
  const response = await app.handle(new Request(`http://localhost${path}`, {
    method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const text = await response.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, headers: response.headers };
}
async function person(name: string) {
  const r = await req("POST", "/auth/register", { name, email: `hook-${crypto.randomUUID()}@example.invalid`, password: "Dev-only-password123!" });
  expect(r.status).toBe(200);
  userIds.push(r.data.user.id);
  return r.data as typeof owner;
}
function management(channel = channelId) { return `/channels/${channel}/incoming-webhooks`; }
async function create(name = "Uptime Kuma", token = owner.accessToken, channel = channelId) {
  const r = await req("POST", management(channel), { name }, token);
  expect(r.status).toBe(201);
  return r.data as { webhook: { id: string; name: string }; path: string };
}
beforeAll(async () => {
  const bus = new LocalRealtimeBus();
  await setRealtimeBusForTests(bus);
  await bus.subscribe(event => { events.push(event); });
  owner = await person("Webhook owner");
  const w = await req("POST", "/workspaces/create", { name: `Hook tests ${crypto.randomUUID()}` }, owner.accessToken);
  expect(w.status).toBe(200);
  workspaceId = w.data.id;
  workspaceIds.push(workspaceId);
  const detail = await req("GET", `/workspaces/${workspaceId}`, undefined, owner.accessToken);
  channelId = detail.data.channels[0].id;
});
afterAll(async () => {
  for (const id of workspaceIds) {
    const detail = await req("GET", `/workspaces/${id}`, undefined, owner.accessToken);
    for (const ch of detail.data.channels ?? []) {
      const rows = await db.select({ id: incomingWebhooks.userId }).from(incomingWebhooks).where(eq(incomingWebhooks.conversationId, ch.id));
      userIds.push(...rows.map(r => r.id));
    }
    await db.delete(workspaces).where(eq(workspaces.id, id));
  }
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
  await closeRealtimeBusForTests();
});

test("a URL posts as its named bot, with durable unread/outbox and live delivery", async () => {
  const hook = await create();
  const token = hook.path.split("/").at(-1)!;
  const list = await req("GET", management(), undefined, owner.accessToken);
  expect(list.status).toBe(200);
  expect(list.data.webhooks).toContainEqual(expect.objectContaining({ id: hook.webhook.id, name: "Uptime Kuma", lastUsedAt: null }));
  expect(JSON.stringify(list.data)).not.toContain(token);
  expect(JSON.stringify(list.data)).not.toContain("tokenHash");
  const [stored] = await db.select().from(incomingWebhooks).where(eq(incomingWebhooks.id, hook.webhook.id));
  expect(stored.tokenHash).toBe(crypto.createHash("sha256").update(token).digest("hex"));
  expect(JSON.stringify(stored)).not.toContain(token);
  const post = await req("POST", hook.path, { text: "Checkout DOWN: HTTP 503", unknown: "ignored" });
  expect(post.status).toBe(200);
  expect(post.data).toBe("ok");
  const history = await req("GET", `/messages/${channelId}`, undefined, owner.accessToken);
  const message = history.data.find((m: any) => m.content === "Checkout DOWN: HTTP 503");
  expect(message).toMatchObject({ senderId: stored.userId, senderName: "Uptime Kuma", senderType: "bot", threadId: null });
  expect(await db.select().from(messageUnreads).where(and(eq(messageUnreads.messageId, message.id), eq(messageUnreads.userId, owner.user.id)))).toHaveLength(1);
  const queued = await db.select().from(queueJobs).where(eq(queueJobs.name, "chat.message.sent"));
  expect(queued.some(row => JSON.stringify(row.event).includes(message.id))).toBe(true);
  expect(events.some(e => e.targetUserIds.includes(owner.user.id) && e.event.type === "new_message" && e.event.message.id === message.id)).toBe(true);
});

test("revoked and incorrect URLs return 404; revocation preserves history", async () => {
  const hook = await create("Retired monitor");
  expect((await req("POST", hook.path, { text: "Before revocation" })).status).toBe(200);
  expect((await req("DELETE", `${management()}/${hook.webhook.id}`, undefined, owner.accessToken)).status).toBe(200);
  for (const path of [hook.path, `/hooks/incoming/tchat_wh_${"0".repeat(64)}`, "/hooks/incoming/not-a-token"]) {
    expect((await req("POST", path, { text: "Rejected" })).status).toBe(404);
  }
  const history = await req("GET", `/messages/${channelId}`, undefined, owner.accessToken);
  expect(history.data.find((m: any) => m.content === "Before revocation")?.senderName).toBe("Retired monitor");
  expect(history.data.some((m: any) => m.content === "Rejected")).toBe(false);
});

test("only human workspace managers can create/list/revoke, not members or outsiders", async () => {
  const member = await person("Member");
  const outsider = await person("Outsider");
  await req("POST", `/workspaces/${workspaceId}/join`, undefined, member.accessToken);
  // Seed membership using the same table, independently of open/join policy.
  await db.insert(workspaceMembers).values({ workspaceId, userId: member.user.id, role: "member" }).onConflictDoNothing();
  const hook = await create();
  for (const token of [member.accessToken, outsider.accessToken, undefined]) {
    for (const [method, path, body] of [["POST", management(), { name: "Denied" }], ["GET", management(), undefined], ["DELETE", `${management()}/${hook.webhook.id}`, undefined]] as const) {
      expect((await req(method, path, body, token)).status).toBe(token ? 403 : 401);
    }
  }
  // Existing owners/admins in the channel are allowed.
  await db.update(workspaceMembers).set({ role: "admin" }).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, owner.user.id)));
  expect((await req("GET", management(), undefined, owner.accessToken)).status).toBe(200);
  await create("Admin created");
  await db.update(workspaceMembers).set({ role: "owner" }).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, owner.user.id)));
});

test("a webhook cannot override its channel, sender, thread or authenticate elsewhere", async () => {
  const other = await req("POST", "/conversations/channel", { workspaceId, name: "other-channel" }, owner.accessToken);
  expect(other.status).toBe(200);
  const hook = await create("Fixed sender");
  const post = await req("POST", hook.path + `?conversationId=${other.data.id}`, {
    text: "Bound to original", channel: other.data.id, conversationId: other.data.id,
    senderId: owner.user.id, username: "Spoof", threadId: crypto.randomUUID(),
  });
  expect(post.status).toBe(200);
  const history = await req("GET", `/messages/${channelId}`, undefined, owner.accessToken);
  expect(history.data.find((m: any) => m.content === "Bound to original")).toMatchObject({ senderName: "Fixed sender", threadId: null });
  expect((await req("GET", `/messages/${other.data.id}`, undefined, owner.accessToken)).data).toHaveLength(0);
  expect((await req("DELETE", `${management(other.data.id)}/${hook.webhook.id}`, undefined, owner.accessToken)).status).toBe(404);
  expect((await req("POST", `/messages/${other.data.id}`, { content: "No" }, hook.path.split("/").at(-1))).status).toBe(401);
});

test("oversized bodies are rejected by byte count, including streams without Content-Length", async () => {
  const hook = await create();
  const response = await req("POST", hook.path, { text: "🦔".repeat(20_000) });
  expect(response.status).toBe(413);
  expect(response.data.error).toContain("65536");
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"text":"'));
    controller.enqueue(new Uint8Array(65_537).fill(97));
    controller.close();
  } });
  const streamed = await app.handle(new Request(`http://localhost${hook.path}`, { method: "POST", headers: { "content-type": "application/json" }, body: stream }));
  expect(streamed.status).toBe(413);
});

test("rate limit is atomic across concurrent requests and scoped to one webhook", async () => {
  const hook = await create();
  const results = await Promise.all(Array.from({ length: 33 }, (_, i) => req("POST", hook.path, { text: `Rate ${hook.webhook.id} ${i}` })));
  expect(results.filter(r => r.status === 200)).toHaveLength(30);
  const limited = results.filter(r => r.status === 429);
  expect(limited).toHaveLength(3);
  expect(Number(limited[0].headers.get("retry-after"))).toBeGreaterThan(0);
  expect(limited[0].data.error).toContain("Rate limit");
  const other = await create();
  expect((await req("POST", other.path, { text: "Independent budget" })).status).toBe(200);
});

test("Slack attachment and block-only messages render useful text instead of blank alerts", async () => {
  const hook = await create();
  const r = await req("POST", hook.path, {
    attachments: [{ color: "danger", fallback: "Fallback", pretext: "Monitor status", title: "Checkout", title_link: "https://example.invalid", text: "DOWN", fields: [{ title: "Reason", value: "HTTP 503", short: true }] }],
    blocks: [{ type: "section", text: { type: "mrkdwn", text: "<https://example.invalid/status|Status page>" } }],
  });
  expect(r.status).toBe(200);
  const history = (await req("GET", `/messages/${channelId}`, undefined, owner.accessToken)).data;
  const msg = history.at(-1).content;
  for (const value of ["Monitor status", "Checkout", "DOWN", "Reason", "HTTP 503", "Status page", "https://example.invalid/status"]) expect(msg).toContain(value);
  expect(msg).not.toContain("Fallback");
});
