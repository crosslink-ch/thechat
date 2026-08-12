import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "crypto";
import { eq, inArray } from "drizzle-orm";
import { Elysia } from "elysia";
import { authRoutes } from "../auth";
import { db } from "../db";
import { users, workspaceMembers, workspaces } from "../db/schema";
import {
  LocalPresenceRegistry,
  closePresenceRegistryForTests,
  listSharedWorkspacePeerIds,
  setPresenceRegistryForTests,
} from "../presence";
import { wsRoutes } from ".";

const app = new Elysia().use(authRoutes).use(wsRoutes).listen(0);
const baseUrl = `http://127.0.0.1:${app.server!.port}`;
const createdEmails: string[] = [];
const createdWorkspaceIds: string[] = [];
const createdUserIds: string[] = [];
const presenceRegistry = new LocalPresenceRegistry();

beforeAll(async () => {
  await setPresenceRegistryForTests(presenceRegistry);
});

afterAll(async () => {
  app.stop();
  if (createdWorkspaceIds.length > 0) {
    await db.delete(workspaces).where(inArray(workspaces.id, createdWorkspaceIds));
  }
  for (const email of createdEmails) {
    await db.delete(users).where(eq(users.email, email));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await closePresenceRegistryForTests();
});

async function register(name: string) {
  const email = `ws-presence-${name.toLowerCase()}-${crypto.randomUUID()}@test.com`;
  createdEmails.push(email);
  const response = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, email, password: "password123" }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as any;
}

function waitForOpen(socket: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket open timeout")), 5_000);
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

function waitForEvent(
  socket: WebSocket,
  predicate: (event: any) => boolean,
  timeoutMs = 5_000,
) {
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error("websocket event timeout"));
    }, timeoutMs);
    const onMessage = (message: MessageEvent) => {
      const event = JSON.parse(String(message.data));
      if (!predicate(event)) return;
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      resolve(event);
    };
    socket.addEventListener("message", onMessage);
  });
}

function expectNoEvent(
  socket: WebSocket,
  predicate: (event: any) => boolean,
  timeoutMs = 350,
) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      resolve();
    }, timeoutMs);
    const onMessage = (message: MessageEvent) => {
      const event = JSON.parse(String(message.data));
      if (!predicate(event)) return;
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      reject(new Error(`unexpected websocket event: ${JSON.stringify(event)}`));
    };
    socket.addEventListener("message", onMessage);
  });
}

async function connect(token: string) {
  const socket = new WebSocket(baseUrl.replace("http://", "ws://") + "/ws");
  await waitForOpen(socket);
  const authenticated = waitForEvent(socket, (event) => event.type === "auth_ok");
  socket.send(JSON.stringify({ type: "auth", token }));
  await authenticated;
  return socket;
}

describe("WebSocket presence", () => {
  test("does not leave a presence lease for a socket closed during authentication", async () => {
    const closingUser = await register("Closing");
    const socket = new WebSocket(baseUrl.replace("http://", "ws://") + "/ws");
    await waitForOpen(socket);
    const closed = new Promise<void>((resolve) => {
      socket.addEventListener("close", () => resolve(), { once: true });
    });
    socket.send(
      JSON.stringify({ type: "auth", token: closingUser.accessToken }),
    );
    socket.close();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await presenceRegistry.onlineUserIds([closingUser.user.id])).toEqual(
      [],
    );
  });

  test("scopes status to workspace peers and stays online until the last socket closes", async () => {
    const alice = await register("Alice");
    const bob = await register("Bob");
    const carol = await register("Carol");
    const workspaceId = `presence-${crypto.randomUUID()}`;
    const botId = crypto.randomUUID();
    createdWorkspaceIds.push(workspaceId);
    createdUserIds.push(botId);
    await db.insert(users).values({
      id: botId,
      name: "Workspace Bot",
      type: "bot",
    });
    await db.insert(workspaces).values({
      id: workspaceId,
      name: "Presence Test",
      createdById: alice.user.id,
    });
    await db.insert(workspaceMembers).values([
      { workspaceId, userId: alice.user.id, role: "owner" },
      { workspaceId, userId: bob.user.id, role: "member" },
      { workspaceId, userId: botId, role: "member" },
    ]);
    expect(await listSharedWorkspacePeerIds(alice.user.id)).toEqual([
      bob.user.id,
    ]);

    const sockets: WebSocket[] = [];
    try {
      const aliceSocket = await connect(alice.accessToken);
      const carolSocket = await connect(carol.accessToken);
      sockets.push(aliceSocket, carolSocket);

      const carolEmptySnapshot = waitForEvent(
        carolSocket,
        (event) => event.type === "presence_snapshot",
      );
      carolSocket.send(JSON.stringify({ type: "ping" }));
      await expect(carolEmptySnapshot).resolves.toMatchObject({
        type: "presence_snapshot",
        userIds: [],
      });

      const aliceSeesBob = waitForEvent(
        aliceSocket,
        (event) =>
          event.type === "presence_changed" &&
          event.userId === bob.user.id &&
          event.online === true,
      );
      const carolDoesNotSeeBob = expectNoEvent(
        carolSocket,
        (event) => event.type === "presence_changed" && event.userId === bob.user.id,
      );

      const firstBobSocket = new WebSocket(
        baseUrl.replace("http://", "ws://") + "/ws",
      );
      await waitForOpen(firstBobSocket);
      sockets.push(firstBobSocket);
      const bobAuthenticated = waitForEvent(
        firstBobSocket,
        (event) => event.type === "auth_ok",
      );
      const bobSnapshot = waitForEvent(
        firstBobSocket,
        (event) => event.type === "presence_snapshot",
      );
      firstBobSocket.send(
        JSON.stringify({ type: "auth", token: bob.accessToken }),
      );

      await expect(bobAuthenticated).resolves.toMatchObject({
        type: "auth_ok",
        userId: bob.user.id,
      });
      await expect(bobSnapshot).resolves.toMatchObject({
        type: "presence_snapshot",
        userIds: [alice.user.id],
      });
      await expect(aliceSeesBob).resolves.toMatchObject({
        type: "presence_changed",
        userId: bob.user.id,
        online: true,
      });
      await carolDoesNotSeeBob;

      const noReauthFlicker = expectNoEvent(
        aliceSocket,
        (event) =>
          event.type === "presence_changed" && event.userId === bob.user.id,
      );
      const bobReauthenticated = waitForEvent(
        firstBobSocket,
        (event) => event.type === "auth_ok",
      );
      firstBobSocket.send(
        JSON.stringify({ type: "auth", token: bob.accessToken }),
      );
      await bobReauthenticated;
      await noReauthFlicker;

      const secondBobSocket = await connect(bob.accessToken);
      sockets.push(secondBobSocket);

      const noPrematureOffline = expectNoEvent(
        aliceSocket,
        (event) =>
          event.type === "presence_changed" &&
          event.userId === bob.user.id &&
          event.online === false,
      );
      firstBobSocket.close();
      await noPrematureOffline;

      const aliceSeesBobOffline = waitForEvent(
        aliceSocket,
        (event) =>
          event.type === "presence_changed" &&
          event.userId === bob.user.id &&
          event.online === false,
      );
      secondBobSocket.close();
      await expect(aliceSeesBobOffline).resolves.toMatchObject({
        type: "presence_changed",
        userId: bob.user.id,
        online: false,
      });

      const aliceSeesBobReconnect = waitForEvent(
        aliceSocket,
        (event) =>
          event.type === "presence_changed" &&
          event.userId === bob.user.id &&
          event.online === true,
      );
      const thirdBobSocket = await connect(bob.accessToken);
      sockets.push(thirdBobSocket);
      await aliceSeesBobReconnect;

      const aliceSeesRevokedBobOffline = waitForEvent(
        aliceSocket,
        (event) =>
          event.type === "presence_changed" &&
          event.userId === bob.user.id &&
          event.online === false,
      );
      const revokedSocketClosed = new Promise<void>((resolve) => {
        thirdBobSocket.addEventListener("close", () => resolve(), { once: true });
      });
      const logoutResponse = await fetch(`${baseUrl}/auth/logout`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bob.accessToken}`,
          cookie: `better-auth.session_token=${bob.sessionToken}`,
        },
      });
      expect(logoutResponse.status).toBe(200);
      thirdBobSocket.send(JSON.stringify({ type: "ping" }));
      await aliceSeesRevokedBobOffline;
      await revokedSocketClosed;
    } finally {
      for (const socket of sockets) {
        if (socket.readyState !== WebSocket.CLOSED) socket.close();
      }
    }
  });
});
