import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { Elysia } from "elysia";
import { eq, inArray } from "drizzle-orm";
import webpush from "web-push";
import type { PushNotificationPayload } from "@thechat/shared";
import { db } from "../db";
import {
  conversationParticipants,
  eventOutbox,
  pushSubscriptions,
  users,
  workspaceMembers,
  workspaces,
} from "../db/schema";
import { authRoutes } from "../auth";
import { workspaceRoutes } from "../workspaces";
import { conversationRoutes } from "../conversations";
import { messageRoutes } from "../messages";
import { activityRoutes } from "../activity";
import { botRoutes } from "../bots";
import { botRequestRoutes } from "../bot-requests";
import { hermesPlatformRoutes } from "../hermes-platform";
import { closeDomainEventRuntime, startDomainEventRuntime } from "../events/runtime";
import type { AsyncBus, AsyncJob, QueueCommand, QueuedJob } from "../async/types";
import { pushRoutes } from ".";
import { loadWebPushConfig, setWebPushConfigForTests, type WebPushConfig } from "./config";
import { isAllowedPushEndpoint, isValidAuthSecret, isValidP256dhKey } from "./endpoint";
import { classifyMessage, mentionsName } from "./content";
import {
  createPushDeliverHandler,
  createPushFanoutHandler,
  PUSH_DELIVER_JOB_NAME,
  PUSH_FANOUT_JOB_NAME,
  RetryablePushError,
  setPushBusForTests,
} from "./jobs";
import { encodePushPayload, MAX_PUSH_PAYLOAD_BYTES, pushTopic, setPushTransportForTests, type PushRequest } from "./sender";

const app = new Elysia()
  .use(authRoutes)
  .use(workspaceRoutes)
  .use(conversationRoutes)
  .use(messageRoutes)
  .use(activityRoutes)
  .use(botRoutes)
  .use(botRequestRoutes)
  .use(hermesPlatformRoutes)
  .use(pushRoutes);

const vapid = webpush.generateVAPIDKeys();
const CONFIG: WebPushConfig = {
  publicKey: vapid.publicKey,
  privateKey: vapid.privateKey,
  subject: "mailto:push-tests@example.invalid",
  delayMs: 0,
  ttlSeconds: 600,
};

const createdUserEmails: string[] = [];
const createdWorkspaceIds: string[] = [];
const createdBotUserIds: string[] = [];

// -- A fake push service that does what FCM/APNs/Mozilla do: check the VAPID
// -- JWT and hold the encrypted message. Decryption uses the browser's keys.

interface FakeBrowser {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  ecdh: crypto.ECDH;
  authSecret: Buffer;
}

function fakeBrowser(host = "fcm.googleapis.com"): FakeBrowser {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const authSecret = crypto.randomBytes(16);
  return {
    endpoint: `https://${host}/fcm/send/${crypto.randomUUID()}`,
    keys: {
      p256dh: ecdh.getPublicKey().toString("base64url"),
      auth: authSecret.toString("base64url"),
    },
    ecdh,
    authSecret,
  };
}

const hmac = (key: Buffer, data: Buffer) => crypto.createHmac("sha256", key).update(data).digest();

/** RFC 8291 / RFC 8188 (aes128gcm) decryption, as the browser does it. */
function decryptPush(browser: FakeBrowser, body: Uint8Array): PushNotificationPayload {
  const data = Buffer.from(body);
  const salt = data.subarray(0, 16);
  const idLength = data[20]!;
  const serverPublicKey = data.subarray(21, 21 + idLength);
  const ciphertext = data.subarray(21 + idLength);
  const sharedSecret = browser.ecdh.computeSecret(serverPublicKey);
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    browser.ecdh.getPublicKey(),
    serverPublicKey,
  ]);
  const ikm = hmac(hmac(browser.authSecret, sharedSecret), Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end -= 1;
  expect(padded[end]).toBe(2); // last-record delimiter
  return JSON.parse(padded.subarray(0, end).toString("utf8"));
}

/** Verify the VAPID authorization the way a push service does. */
function verifyVapid(request: PushRequest) {
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(request.headers.Authorization ?? request.headers.authorization ?? "");
  expect(match).not.toBeNull();
  const [, jwt, key] = match!;
  expect(key).toBe(CONFIG.publicKey);
  const [header, claims, signature] = jwt!.split(".");
  const publicKey = crypto.createPublicKey({
    key: { kty: "EC", crv: "P-256", ...rawP256ToJwk(Buffer.from(key!, "base64url")) },
    format: "jwk",
  });
  const valid = crypto.verify(
    "sha256",
    Buffer.from(`${header}.${claims}`),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature!, "base64url"),
  );
  expect(valid).toBe(true);
  const decoded = JSON.parse(Buffer.from(claims!, "base64url").toString("utf8"));
  expect(decoded.aud).toBe(new URL(request.url).origin);
  expect(decoded.sub).toBe(CONFIG.subject);
  expect(decoded.exp * 1000).toBeGreaterThan(Date.now());
}

function rawP256ToJwk(raw: Buffer) {
  return { x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33, 65).toString("base64url") };
}

type Delivered = { request: PushRequest; payload: PushNotificationPayload };
let delivered: Delivered[] = [];
const browsers = new Map<string, FakeBrowser>();
let nextStatus: number[] = [];

function installFakePushService() {
  setPushTransportForTests(async (request) => {
    const status = nextStatus.shift() ?? 201;
    if (status >= 200 && status < 300) {
      verifyVapid(request);
      const browser = browsers.get(request.url);
      if (!browser) throw new Error("Push sent to an endpoint no browser owns");
      delivered.push({ request, payload: decryptPush(browser, request.body) });
    }
    return { status, headers: new Headers(status === 429 ? { "retry-after": "7" } : {}) };
  });
}

// -- An in-memory queue with BullMQ's job-id idempotency -------------------

class RecordingBus implements AsyncBus {
  jobs = new Map<string, QueueCommand<any>>();
  async enqueue<T>(command: QueueCommand<T>): Promise<QueuedJob> {
    if (!this.jobs.has(command.jobId)) this.jobs.set(command.jobId, command);
    return { queue: command.queue, name: command.name, bullmqJobId: command.jobId, messageId: command.message.id };
  }
  pending(name: string) {
    return [...this.jobs.values()].filter((job) => job.name === name);
  }
}

let bus: RecordingBus;
const processed = new Set<string>();

function asJob<T>(command: QueueCommand<T>): AsyncJob<T> {
  return {
    queue: command.queue,
    name: command.name,
    bullmqJobId: command.jobId,
    message: command.message,
    attemptsMade: 0,
    maxAttempts: command.attempts ?? 1,
  };
}

const noProgress = { setProgress: async () => undefined };

/** Run every queued fan-out, then every delivery, once. */
async function drainPushJobs() {
  const fanout = createPushFanoutHandler();
  const deliver = createPushDeliverHandler();
  for (const command of bus.pending(PUSH_FANOUT_JOB_NAME)) {
    if (processed.has(command.jobId)) continue;
    processed.add(command.jobId);
    await fanout.handle(asJob(command), noProgress);
  }
  const results: unknown[] = [];
  for (const command of bus.pending(PUSH_DELIVER_JOB_NAME)) {
    if (processed.has(command.jobId)) continue;
    processed.add(command.jobId);
    results.push(await deliver.handle(asJob(command), noProgress));
  }
  return results;
}

async function waitForFanout(sourceKey: string) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (bus.jobs.has(`push-fanout:${sourceKey}`)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`No push fan-out was scheduled for ${sourceKey}`);
}

// -- API helpers ------------------------------------------------------------

async function req(method: string, path: string, body?: unknown, token?: string) {
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
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {
    // keep text
  }
  return { status: response.status, body: json };
}

async function registerUser(name: string) {
  const email = `push-${crypto.randomUUID()}@test.com`;
  createdUserEmails.push(email);
  const res = await req("POST", "/auth/register", { name, email, password: "password123" });
  expect(res.status).toBe(200);
  return {
    token: res.body.accessToken as string,
    user: res.body.user as { id: string; name: string },
    email,
  };
}

async function login(email: string) {
  const res = await req("POST", "/auth/login", { email, password: "password123" });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

/** Owner and a member sharing a workspace, its #general channel and a DM. */
async function fixture(label: string) {
  const owner = await registerUser(`${label} Owner`);
  const member = await registerUser(`${label} Member`);
  const ws = await req("POST", "/workspaces/create", { name: `${label} ws` }, owner.token);
  expect(ws.status).toBe(200);
  createdWorkspaceIds.push(ws.body.id);
  const detail = await req("GET", `/workspaces/${ws.body.id}`, undefined, owner.token);
  const channelId = detail.body.channels[0].id as string;
  await db.insert(workspaceMembers).values({ workspaceId: ws.body.id, userId: member.user.id, role: "member" });
  await db.insert(conversationParticipants).values({ conversationId: channelId, userId: member.user.id });
  const dm = await req("POST", "/conversations/dm", { workspaceId: ws.body.id, otherUserId: member.user.id }, owner.token);
  expect(dm.status).toBe(200);
  return { owner, member, workspaceId: ws.body.id as string, channelId, dmId: dm.body.id as string };
}

async function subscribe(token: string, host?: string) {
  const browser = fakeBrowser(host);
  const res = await req(
    "POST",
    "/push/subscriptions",
    { endpoint: browser.endpoint, keys: browser.keys, applicationServerKey: CONFIG.publicKey },
    token,
  );
  expect(res.status).toBe(200);
  browsers.set(browser.endpoint, browser);
  return browser;
}

async function send(token: string, conversationId: string, content: string) {
  const res = await req("POST", `/messages/${conversationId}`, { content }, token);
  expect(res.status).toBe(200);
  return res.body as { id: string };
}

beforeAll(async () => {
  setWebPushConfigForTests(CONFIG);
  installFakePushService();
  await startDomainEventRuntime();
});

beforeEach(() => {
  bus = new RecordingBus();
  setPushBusForTests(bus);
  delivered = [];
  nextStatus = [];
});

afterAll(async () => {
  await closeDomainEventRuntime();
  setPushBusForTests(null);
  setPushTransportForTests(null);
  setWebPushConfigForTests(undefined);
  const humans = createdUserEmails.length
    ? await db.select({ id: users.id }).from(users).where(inArray(users.email, createdUserEmails))
    : [];
  const actorIds = [...createdBotUserIds, ...humans.map((user) => user.id)];
  if (actorIds.length) await db.delete(eventOutbox).where(inArray(eventOutbox.actorId, actorIds));
  if (createdWorkspaceIds.length) {
    await db.delete(eventOutbox).where(inArray(eventOutbox.tenantId, createdWorkspaceIds));
  }
  for (const id of createdBotUserIds) await db.delete(users).where(eq(users.id, id));
  for (const id of createdWorkspaceIds) await db.delete(workspaces).where(eq(workspaces.id, id));
  for (const human of humans) await db.delete(users).where(eq(users.id, human.id));
});

// -- Pure rules ---------------------------------------------------------------

describe("push endpoint and key validation", () => {
  test("only real browser push services are reachable", () => {
    for (const endpoint of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/QGx1",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
    ]) {
      expect(isAllowedPushEndpoint(endpoint)).toBe(true);
    }
    for (const endpoint of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com.evil.example/x",
      "https://evilfcm.googleapis.com/x",
      "https://169.254.169.254/latest/meta-data",
      "https://localhost/x",
      "https://user:pass@fcm.googleapis.com/x",
      "https://fcm.googleapis.com:8443/x",
      "https://notify.windows.com.evil.example/x",
      `https://fcm.googleapis.com/${"a".repeat(2100)}`,
      "not a url",
    ]) {
      expect(isAllowedPushEndpoint(endpoint)).toBe(false);
    }
  });

  test("subscription keys must be a P-256 point and a 16-byte secret", () => {
    const browser = fakeBrowser();
    expect(isValidP256dhKey(browser.keys.p256dh)).toBe(true);
    expect(isValidAuthSecret(browser.keys.auth)).toBe(true);
    expect(isValidP256dhKey(Buffer.alloc(65).toString("base64url"))).toBe(false);
    expect(isValidAuthSecret(Buffer.alloc(12).toString("base64url"))).toBe(false);
    expect(isValidAuthSecret("not base64!")).toBe(false);
  });

  test("configuration is optional but never half-configured", () => {
    expect(loadWebPushConfig({})).toBeNull();
    expect(() => loadWebPushConfig({ WEB_PUSH_VAPID_PUBLIC_KEY: vapid.publicKey })).toThrow();
    expect(() =>
      loadWebPushConfig({
        WEB_PUSH_VAPID_PUBLIC_KEY: vapid.publicKey,
        WEB_PUSH_VAPID_PRIVATE_KEY: vapid.privateKey,
        WEB_PUSH_SUBJECT: "not-a-contact",
      }),
    ).toThrow();
    expect(
      loadWebPushConfig({
        WEB_PUSH_VAPID_PUBLIC_KEY: vapid.publicKey,
        WEB_PUSH_VAPID_PRIVATE_KEY: vapid.privateKey,
        WEB_PUSH_SUBJECT: "mailto:ops@example.invalid",
      }),
    ).toMatchObject({ publicKey: vapid.publicKey, delayMs: 3000 });
  });

  test("mentions follow the client's @Display Name rule", () => {
    expect(mentionsName("hey @Ana Lee, look", "Ana Lee")).toBe(true);
    expect(mentionsName("@ana lee", "Ana Lee")).toBe(true);
    expect(mentionsName("mail ana@Ana Lee.example", "Ana Lee")).toBe(false);
    expect(mentionsName("@Ana Leeds", "Ana Lee")).toBe(false);
    expect(mentionsName("no mention", "Ana Lee")).toBe(false);
  });

  test("agents answering you in a channel count as replies without a mention", () => {
    const recipient = { userId: "u1", name: "Ana" };
    const base = { conversationType: "group" as const, content: "done" };
    expect(classifyMessage({ ...base, senderType: "bot" }, recipient, "u1")).toBe("agent_reply");
    expect(classifyMessage({ ...base, senderType: "bot" }, recipient, "u2")).toBeNull();
    expect(classifyMessage({ ...base, senderType: "human" }, recipient)).toBeNull();
    expect(classifyMessage({ conversationType: "direct", content: "x", senderType: "bot" }, recipient)).toBe("agent_reply");
  });

  test("oversized previews shrink to fit the push size limit and topics stay valid", () => {
    const payload: PushNotificationPayload = {
      v: 1, id: "m", kind: "direct_message", title: "T", body: "é".repeat(4000),
      tag: "conversation:x:main", url: "#/", timestamp: 0,
    };
    const encoded = encodePushPayload(payload);
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(MAX_PUSH_PAYLOAD_BYTES);
    expect(JSON.parse(encoded).body.endsWith("…")).toBe(true);
    const topic = pushTopic("conversation:2f6c0f6e-8c55-4c39-9a8a-3b1c5c0e9d7a:3c1e1a7b-2a77-4c55-9d11-0f0d6a3e8b21");
    expect(topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    expect(pushTopic("conversation:a:main")).not.toBe(pushTopic("conversation:b:main"));
  });
});

// -- Routes -------------------------------------------------------------------

describe("push routes", () => {
  test("require a signed-in human", async () => {
    expect((await req("GET", "/push/config")).status).toBe(401);
    expect((await req("GET", "/push/preferences")).status).toBe(401);
  });

  test("report the public key and validate subscriptions", async () => {
    const { token } = await registerUser("Routes");
    expect((await req("GET", "/push/config", undefined, token)).body).toEqual({
      enabled: true,
      publicKey: CONFIG.publicKey,
    });

    const browser = fakeBrowser();
    const body = { endpoint: browser.endpoint, keys: browser.keys, applicationServerKey: CONFIG.publicKey };
    const internal = await req("POST", "/push/subscriptions", { ...body, endpoint: "https://10.0.0.1/push" }, token);
    expect(internal.status).toBe(400);
    const badKeys = await req("POST", "/push/subscriptions", { ...body, keys: { ...body.keys, auth: "AAAA" } }, token);
    expect(badKeys.status).toBe(400);
    const oldKey = await req(
      "POST",
      "/push/subscriptions",
      { ...body, applicationServerKey: webpush.generateVAPIDKeys().publicKey },
      token,
    );
    expect(oldKey.status).toBe(409);
    const extra = await req("POST", "/push/subscriptions", { ...body, sneaky: true }, token);
    expect(extra.status).toBe(400);

    expect((await req("POST", "/push/subscriptions", body, token)).status).toBe(200);
    expect((await req("POST", "/push/subscriptions/status", { endpoint: browser.endpoint }, token)).body).toEqual({
      registered: true,
      current: true,
    });
    expect((await req("DELETE", "/push/subscriptions", { endpoint: browser.endpoint }, token)).body).toEqual({
      removed: true,
    });
    expect((await req("POST", "/push/subscriptions/status", { endpoint: browser.endpoint }, token)).body.registered).toBe(false);
  });

  test("a browser moves to whoever signs in on it, and never keeps the old account", async () => {
    const first = await registerUser("First");
    const second = await registerUser("Second");
    const browser = await subscribe(first.token);
    const again = await req(
      "POST",
      "/push/subscriptions",
      { endpoint: browser.endpoint, keys: browser.keys, applicationServerKey: CONFIG.publicKey },
      second.token,
    );
    expect(again.status).toBe(200);
    const rows = await db
      .select({ userId: pushSubscriptions.userId })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, browser.endpoint));
    expect(rows).toEqual([{ userId: second.user.id }]);
    // The first account cannot remove or test the second account's device.
    expect((await req("DELETE", "/push/subscriptions", { endpoint: browser.endpoint }, first.token)).body.removed).toBe(false);
    expect((await req("POST", "/push/test", { endpoint: browser.endpoint }, first.token)).status).toBe(404);
  });

  test("logging out removes the device; signing in again needs a fresh registration", async () => {
    const user = await registerUser("Logout");
    const email = user.email;
    const browser = await subscribe(user.token);
    expect((await req("POST", "/auth/logout", {}, user.token)).status).toBe(200);
    const rows = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, browser.endpoint));
    expect(rows).toHaveLength(0);

    const token = await login(email);
    expect((await req("POST", "/push/subscriptions/status", { endpoint: browser.endpoint }, token)).body.registered).toBe(false);
  });

  test("preferences default on and patch individually", async () => {
    const { token } = await registerUser("Prefs");
    expect((await req("GET", "/push/preferences", undefined, token)).body).toEqual({
      directMessages: true, mentions: true, agentReplies: true, agentRequests: true, showPreviews: true,
    });
    expect((await req("PATCH", "/push/preferences", {}, token)).status).toBe(400);
    expect((await req("PATCH", "/push/preferences", { mentions: "no" }, token)).status).toBe(400);
    const patched = await req("PATCH", "/push/preferences", { mentions: false, showPreviews: false }, token);
    expect(patched.body).toMatchObject({ mentions: false, showPreviews: false, directMessages: true });
    expect((await req("GET", "/push/preferences", undefined, token)).body.mentions).toBe(false);
  });

  test("a test notification reaches this device, encrypted and VAPID-signed", async () => {
    const { token } = await registerUser("Tester");
    const browser = await subscribe(token);
    const res = await req("POST", "/push/test", { endpoint: browser.endpoint }, token);
    expect(res.body).toEqual({ result: "accepted" });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.request.url).toBe(browser.endpoint);
    expect(delivered[0]!.payload).toMatchObject({ kind: "test", title: "TheChat", url: "#/settings" });
    expect(delivered[0]!.request.headers.TTL ?? delivered[0]!.request.headers.ttl).toBe("600");
    // Rate limited per account.
    expect((await req("POST", "/push/test", { endpoint: browser.endpoint }, token)).status).toBe(429);
  });
});

// -- Delivery -------------------------------------------------------------------

describe("push delivery", () => {
  test("a direct message notifies the other person's devices, never the sender's", async () => {
    const f = await fixture("DM");
    const phone = await subscribe(f.member.token);
    // A second device is a second signed-in session (one browser per session).
    const laptopSession = await login(f.member.email);
    const laptop = await subscribe(laptopSession, "updates.push.services.mozilla.com");
    await subscribe(f.owner.token);

    const message = await send(f.owner.token, f.dmId, "Lunch at noon?");
    await waitForFanout(`message:${message.id}`);
    await drainPushJobs();

    expect(delivered.map((entry) => entry.request.url).sort()).toEqual([laptop.endpoint, phone.endpoint].sort());
    const payload = delivered[0]!.payload;
    expect(payload).toMatchObject({
      v: 1,
      id: `message:${message.id}`,
      kind: "direct_message",
      title: "DM Owner",
      body: "Lunch at noon?",
      tag: `conversation:${f.dmId}:main`,
      badge: 1,
    });
    expect(payload.url).toBe(
      `#/open?conversationId=${f.dmId}&type=direct&workspaceId=${f.workspaceId}`,
    );
    expect(delivered[0]!.request.headers.Topic ?? delivered[0]!.request.headers.topic).toBe(pushTopic(payload.tag));
  });

  test("an outbox replay never sends twice", async () => {
    const f = await fixture("Replay");
    await subscribe(f.member.token);
    const message = await send(f.owner.token, f.dmId, "once");
    await waitForFanout(`message:${message.id}`);
    await drainPushJobs();
    // Same source again (an outbox retry): BullMQ job ids are deterministic.
    const { schedulePushNotifications } = await import("./jobs");
    await schedulePushNotifications({ type: "message", messageId: message.id });
    expect(bus.pending(PUSH_FANOUT_JOB_NAME)).toHaveLength(1);
    await drainPushJobs();
    expect(delivered).toHaveLength(1);
  });

  test("a message read on another device before delivery does not buzz the phone", async () => {
    const f = await fixture("Read");
    await subscribe(f.member.token);
    const message = await send(f.owner.token, f.dmId, "already seen");
    await waitForFanout(`message:${message.id}`);
    const read = await req("POST", `/activity/conversations/${f.dmId}/read`, { messageIds: [message.id] }, f.member.token);
    expect(read.status).toBe(200);
    const results = await drainPushJobs();
    expect(delivered).toHaveLength(0);
    expect(results).toEqual([{ status: "skipped", reason: "nothing_to_send" }]);
  });

  test("channels notify only people who are @mentioned", async () => {
    const f = await fixture("Channel");
    await subscribe(f.member.token);
    const plain = await send(f.owner.token, f.channelId, "status update for everyone");
    const mention = await send(f.owner.token, f.channelId, "@Channel Member can you review?");
    await waitForFanout(`message:${plain.id}`);
    await waitForFanout(`message:${mention.id}`);
    await drainPushJobs();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.payload).toMatchObject({
      kind: "mention",
      title: "Channel Owner in #general",
      body: "@Channel Member can you review?",
      tag: `conversation:${f.channelId}:main`,
    });
    expect(delivered[0]!.payload.url).toContain("type=group");
  });

  test("preferences are honoured at send time, including hidden previews", async () => {
    const f = await fixture("Prefs DM");
    await subscribe(f.member.token);
    await req("PATCH", "/push/preferences", { showPreviews: false }, f.member.token);
    const first = await send(f.owner.token, f.dmId, "secret plans");
    await waitForFanout(`message:${first.id}`);
    await drainPushJobs();
    expect(delivered[0]!.payload.body).toBe("Sent you a message");
    expect(JSON.stringify(delivered[0]!.payload)).not.toContain("secret plans");

    delivered = [];
    const second = await send(f.owner.token, f.dmId, "another one");
    await waitForFanout(`message:${second.id}`);
    // Turned off after queuing, before delivery.
    await req("PATCH", "/push/preferences", { directMessages: false }, f.member.token);
    await drainPushJobs();
    expect(delivered).toHaveLength(0);
  });

  test("someone removed from the workspace is not notified", async () => {
    const f = await fixture("Removed");
    await subscribe(f.member.token);
    const message = await send(f.owner.token, f.channelId, "@Removed Member are you there?");
    await waitForFanout(`message:${message.id}`);
    const removed = await req("DELETE", `/workspaces/${f.workspaceId}/members/${f.member.user.id}`, undefined, f.owner.token);
    expect(removed.status).toBe(200);
    await drainPushJobs();
    expect(delivered).toHaveLength(0);
  });

  test("expired subscriptions are deleted; throttling retries; other rejections count", async () => {
    const f = await fixture("Status");
    const gone = await subscribe(f.member.token);
    const message = await send(f.owner.token, f.dmId, "first");
    await waitForFanout(`message:${message.id}`);
    nextStatus = [410];
    await drainPushJobs();
    expect(await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, gone.endpoint))).toHaveLength(0);

    const throttled = await subscribe(f.member.token);
    const second = await send(f.owner.token, f.dmId, "second");
    await waitForFanout(`message:${second.id}`);
    nextStatus = [429];
    await expect(drainPushJobs()).rejects.toBeInstanceOf(RetryablePushError);
    const [row] = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, throttled.endpoint));
    expect(row?.failureCount).toBe(0);

    // The retried job succeeds.
    const retry = bus.pending(PUSH_DELIVER_JOB_NAME).at(-1)!;
    expect(await createPushDeliverHandler().handle(asJob(retry), noProgress)).toMatchObject({ status: "accepted" });

    nextStatus = [400];
    const third = await send(f.owner.token, f.dmId, "third");
    await waitForFanout(`message:${third.id}`);
    await drainPushJobs();
    const [after] = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, throttled.endpoint));
    expect(after?.failureCount).toBe(1);
  });

  test("an agent run notifies once, with its final answer, not its interim messages", async () => {
    const owner = await registerUser("Asker");
    const ws = await req("POST", "/workspaces/create", { name: "Agent ws" }, owner.token);
    createdWorkspaceIds.push(ws.body.id);
    const bot = await req("POST", "/bots/create", { name: "Reply Hermes", kind: "hermes", workspaceId: ws.body.id }, owner.token);
    expect(bot.status).toBe(200);
    createdBotUserIds.push(bot.body.userId);
    const dm = await req("POST", "/conversations/dm", { workspaceId: ws.body.id, otherUserId: bot.body.userId }, owner.token);
    await subscribe(owner.token);
    await send(owner.token, dm.body.id, "Summarise the incident");

    let invocationId: string | undefined;
    const deadline = Date.now() + 8_000;
    while (!invocationId && Date.now() < deadline) {
      const claimed = await req("GET", "/hermes-platform/events?limit=1", undefined, bot.body.apiKey);
      invocationId = claimed.body.events?.[0]?.invocationId;
      if (!invocationId) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(invocationId).toBeDefined();

    const interim = await req("POST", "/hermes-platform/messages", { invocationId, content: "Looking into it" }, bot.body.apiKey);
    expect(interim.status).toBe(200);
    await waitForFanout(`message:${interim.body.messageId}`);
    await drainPushJobs();
    // Still running: the interim message waits instead of notifying.
    expect(delivered).toHaveLength(0);
    expect(bus.jobs.has(`push-fanout:message:${interim.body.messageId}:wait1`)).toBe(true);

    // The Hermes gateway sends its answer, then reports the turn completed.
    const final = await req(
      "POST",
      "/hermes-platform/messages",
      { invocationId, content: "Root cause: expired certificate" },
      bot.body.apiKey,
    );
    expect(final.status).toBe(200);
    await waitForFanout(`message:${final.body.messageId}`);
    await drainPushJobs();
    expect(delivered).toHaveLength(0);

    const completed = await req("POST", `/hermes-platform/invocations/${invocationId}/completed`, {}, bot.body.apiKey);
    expect(completed.status).toBe(200);
    await drainPushJobs();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.payload).toMatchObject({
      id: `message:${final.body.messageId}`,
      kind: "agent_reply",
      title: "Reply Hermes",
      body: "Root cause: expired certificate",
    });
  });

  test("an agent asking for approval notifies the person it is waiting on", async () => {
    const owner = await registerUser("Approver");
    const ws = await req("POST", "/workspaces/create", { name: "Approval ws" }, owner.token);
    createdWorkspaceIds.push(ws.body.id);
    const bot = await req("POST", "/bots/create", { name: "Approval Hermes", kind: "hermes", workspaceId: ws.body.id }, owner.token);
    expect(bot.status).toBe(200);
    createdBotUserIds.push(bot.body.userId);
    await req("POST", "/conversations/dm", { workspaceId: ws.body.id, otherUserId: bot.body.userId }, owner.token);
    await subscribe(owner.token);

    const created = await req(
      "POST",
      "/bot-requests",
      {
        clientKey: "push-approval-1",
        kind: "approval",
        title: "Run the deploy script",
        response: { type: "choice", choices: ["once", "deny"] },
      },
      bot.body.apiKey,
    );
    expect(created.status).toBe(201);
    await drainPushJobs();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.payload).toMatchObject({
      kind: "agent_request",
      title: "Approval Hermes needs your approval",
      body: "Run the deploy script",
      tag: `request:${created.body.request.id}`,
    });

    // Answered before delivery: nothing to send.
    delivered = [];
    const second = await req(
      "POST",
      "/bot-requests",
      { clientKey: "push-approval-2", kind: "approval", title: "Second", response: { type: "choice", choices: ["once", "deny"] } },
      bot.body.apiKey,
    );
    const answer = await req("POST", `/bot-requests/${second.body.request.id}/answer`, { choice: "deny" }, owner.token);
    expect(answer.status).toBe(200);
    await drainPushJobs();
    expect(delivered).toHaveLength(0);
  });
});
