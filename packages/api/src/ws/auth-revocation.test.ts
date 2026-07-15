import { afterAll, describe, expect, test } from "bun:test";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { authRoutes } from "../auth";
import { db } from "../db";
import { users } from "../db/schema";
import { publishWsEventToUsers } from "../realtime";
import { wsRoutes } from ".";

const app = new Elysia().use(authRoutes).use(wsRoutes).listen(0);
const baseUrl = `http://127.0.0.1:${app.server!.port}`;
const createdEmails: string[] = [];

afterAll(async () => {
  app.stop();
  for (const email of createdEmails) {
    await db.delete(users).where(eq(users.email, email));
  }
});

function waitForOpen(socket: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("websocket open timeout")),
      5_000,
    );
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("websocket open failed"));
      },
      { once: true },
    );
  });
}

function nextEvent(socket: WebSocket) {
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("websocket message timeout")),
      5_000,
    );
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        resolve(JSON.parse(String(event.data)));
      },
      { once: true },
    );
  });
}

function waitForClose(socket: WebSocket) {
  return new Promise<CloseEvent>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("websocket close timeout")),
      5_000,
    );
    socket.addEventListener(
      "close",
      (event) => {
        clearTimeout(timer);
        resolve(event);
      },
      { once: true },
    );
  });
}

describe("WebSocket session revocation", () => {
  test("rejects a state-changing send on an already-open socket after logout", async () => {
    const email = `ws-revoke-${crypto.randomUUID()}@test.com`;
    createdEmails.push(email);
    const register = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Socket Revocation",
        email,
        password: "password123",
      }),
    });
    const session = (await register.json()) as any;
    expect(register.status).toBe(200);

    const socket = new WebSocket(baseUrl.replace("http://", "ws://") + "/ws");
    await waitForOpen(socket);
    socket.send(JSON.stringify({ type: "auth", token: session.accessToken }));
    expect(await nextEvent(socket)).toMatchObject({
      type: "auth_ok",
      userId: session.user.id,
    });

    const logout = await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(logout.status).toBe(200);

    socket.send(
      JSON.stringify({
        type: "send_message",
        conversationId: crypto.randomUUID(),
        content: "must not be persisted",
        clientMessageId: crypto.randomUUID(),
      }),
    );
    expect(await nextEvent(socket)).toMatchObject({
      type: "message_error",
      message: "Session expired or revoked",
    });
    socket.close();
  });

  test("does not deliver private inbound events after logout", async () => {
    const email = `ws-passive-revoke-${crypto.randomUUID()}@test.com`;
    createdEmails.push(email);
    const register = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Passive Socket Revocation",
        email,
        password: "password123",
      }),
    });
    const session = (await register.json()) as any;
    expect(register.status).toBe(200);

    const socket = new WebSocket(baseUrl.replace("http://", "ws://") + "/ws");
    await waitForOpen(socket);
    socket.send(JSON.stringify({ type: "auth", token: session.accessToken }));
    expect(await nextEvent(socket)).toMatchObject({
      type: "auth_ok",
      userId: session.user.id,
    });

    const logout = await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(logout.status).toBe(200);

    const closed = waitForClose(socket);
    await publishWsEventToUsers([session.user.id], {
      type: "typing",
      conversationId: crypto.randomUUID(),
      threadId: null,
      userId: crypto.randomUUID(),
      userName: "Must Not Leak",
    });
    await expect(closed).resolves.toBeDefined();
  });
});
