import { afterAll, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { session, users } from "../db/schema";
import { authRoutes } from "../auth";
import { auth } from "../auth/better-auth";
import { wsRoutes } from ".";
import { publishWsEventToUsers } from "../realtime";

const saved = {
  origins: process.env.THECHAT_WEB_ORIGINS,
  backend: process.env.BETTER_AUTH_URL,
};
process.env.THECHAT_WEB_ORIGINS = "https://chat.example.test";
process.env.BETTER_AUTH_URL = "https://api.example.test";
const app = new Elysia()
  .use(authRoutes)
  .use(wsRoutes)
  .listen({ port: 0, hostname: "127.0.0.1" });
const baseUrl = `http://127.0.0.1:${app.server!.port}`;
const emails: string[] = [];
const sockets: WebSocket[] = [];
const web = { origin: "https://chat.example.test", "x-thechat-client": "web" };
afterAll(async () => {
  for (const socket of sockets) socket.close();
  app.stop();
  for (const email of emails)
    await db.delete(users).where(eq(users.email, email));
  for (const [key, value] of [
    ["THECHAT_WEB_ORIGINS", saved.origins],
    ["BETTER_AUTH_URL", saved.backend],
  ]) {
    if (value === undefined) delete process.env[key!];
    else process.env[key!] = value;
  }
});
async function register() {
  const email = `cookie-ws-${crypto.randomUUID()}@test.com`;
  emails.push(email);
  const response = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { ...web, "content-type": "application/json" },
    body: JSON.stringify({ name: "Socket", email, password: "password123" }),
  });
  expect(response.status).toBe(200);
  return {
    cookie: response.headers.get("set-cookie")!.split(";")[0]!,
    user: ((await response.json()) as any).user,
  };
}
async function connect(headers: Record<string, string>) {
  // Bun supports handshake headers; the DOM constructor declaration does not.
  const Socket = WebSocket as unknown as new (
    url: string,
    options: { headers: Record<string, string> },
  ) => WebSocket;
  const socket = new Socket(baseUrl.replace("http:", "ws:") + "/ws", {
    headers,
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("upgrade failed")),
      { once: true },
    );
  });
  return socket;
}
function event(socket: WebSocket) {
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("message timeout")), 2000);
    socket.addEventListener(
      "message",
      (message) => {
        clearTimeout(timer);
        resolve(JSON.parse(String(message.data)));
      },
      { once: true },
    );
  });
}
async function send(socket: WebSocket, frame: unknown) {
  const pending = event(socket);
  socket.send(JSON.stringify(frame));
  return pending;
}

test("cookie auth rejects client-supplied token fields rather than interpreting them as bearer mode", async () => {
  const browser = await register();
  const socket = await connect({ origin: web.origin, cookie: browser.cookie });
  expect(
    await send(socket, {
      type: "auth",
      mode: "cookie",
      token: "untrusted-frame-token",
    }),
  ).toMatchObject({ type: "auth_error", retryable: false });
  socket.close();
});

test("cookie socket auth classifies infrastructure failures as retryable and can retry", async () => {
  const browser = await register();
  const socket = await connect({ origin: web.origin, cookie: browser.cookie });
  const outage = spyOn(auth.api, "getSession").mockRejectedValue(
    new Error("simulated session-store outage"),
  );
  try {
    expect(await send(socket, { type: "auth", mode: "cookie" })).toMatchObject({
      type: "auth_error",
      retryable: true,
    });
  } finally {
    outage.mockRestore();
  }
  expect(await send(socket, { type: "auth", mode: "cookie" })).toMatchObject({
    type: "auth_ok",
    userId: browser.user.id,
  });
  socket.close();
});

test("untrusted or missing handshake Origin cannot authorize a cookie socket", async () => {
  const browser = await register();
  for (const origin of [undefined, "null", "https://evil.example.test"]) {
    const socket = await connect({
      cookie: browser.cookie,
      ...(origin ? { origin } : {}),
    });
    expect(await send(socket, { type: "auth", mode: "cookie" })).toMatchObject({
      type: "auth_error",
      retryable: false,
    });
    socket.close();
  }
});

test("logout and expiry prevent further cookie socket mutations", async () => {
  for (const revocation of ["logout", "expiry"]) {
    const browser = await register();
    const socket = await connect({
      origin: web.origin,
      cookie: browser.cookie,
    });
    expect(await send(socket, { type: "auth", mode: "cookie" })).toMatchObject({
      type: "auth_ok",
    });
    if (revocation === "logout") {
      const response = await fetch(`${baseUrl}/auth/logout`, {
        method: "POST",
        headers: { ...web, cookie: browser.cookie },
      });
      expect(response.status).toBe(200);
    } else {
      await db
        .update(session)
        .set({ expiresAt: new Date(0) })
        .where(eq(session.userId, browser.user.id));
    }
    expect(
      await send(socket, {
        type: "typing",
        conversationId: crypto.randomUUID(),
      }),
    ).toMatchObject({
      type: "auth_error",
      message: "Session expired or revoked",
      retryable: false,
    });
    socket.close();
  }
});

test("revoked cookie sockets cannot receive private inbound events", async () => {
  const browser = await register();
  const socket = await connect({ origin: web.origin, cookie: browser.cookie });
  expect(await send(socket, { type: "auth", mode: "cookie" })).toMatchObject({
    type: "auth_ok",
  });
  await fetch(`${baseUrl}/auth/logout`, {
    method: "POST",
    headers: { ...web, cookie: browser.cookie },
  });
  const leaked: unknown[] = [];
  socket.addEventListener("message", (message) => leaked.push(message.data));
  const closed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("revoked socket did not close")),
      2000,
    );
    socket.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
  await publishWsEventToUsers([browser.user.id], {
    type: "typing",
    conversationId: crypto.randomUUID(),
    threadId: null,
    userId: crypto.randomUUID(),
    userName: "Private",
  });
  await closed;
  expect(leaked).toEqual([]);
});

test("cookie WebSocket auth uses the original handshake session without a token frame", async () => {
  const browser = await register();
  const socket = await connect({ origin: web.origin, cookie: browser.cookie });
  expect(await send(socket, { type: "auth", mode: "cookie" })).toEqual({
    type: "auth_ok",
    userId: browser.user.id,
  });
  socket.close();
});
