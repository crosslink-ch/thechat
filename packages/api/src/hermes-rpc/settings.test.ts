import { afterAll, beforeAll, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  users,
  workspaces,
  workspaceMembers,
  conversations,
  conversationParticipants,
  hermesRpcBotConfigs,
} from "../db/schema";
import { authRoutes } from "../auth";
import { botRoutes } from "../bots";
import { hermesRpcRoutes } from ".";
import { decryptSecret } from "@thechat/hermes-proxy/secrets";
import { removeMember } from "../services/workspaces";
import { removeBotFromWorkspace } from "../services/bots";
import { createHermesProxyServer } from "../../../hermes-proxy/src/server";
import {
  HERMES_PROXY_PROTOCOL,
  hermesProxyTicketProtocol,
} from "@thechat/hermes-proxy/protocol";
import Redis from "ioredis";
import {
  RedisHermesProxyTicketStore,
  setHermesProxyTicketStoreForTests,
  getHermesProxyTicketStore,
} from "@thechat/hermes-proxy/tickets";

const app = new Elysia().use(authRoutes).use(botRoutes).use(hermesRpcRoutes);
const userIds: string[] = [];
const workspaceIds: string[] = [];
let owner: any, member: any, denied: any, foreign: any, bot: any;
let workspaceId: string, ownerDm: string, memberDm: string;
const settingsPath = () => `/bots/${bot.id}/hermes-rpc/settings`;
async function req(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
) {
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
  const text = await response.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, body: data, headers: response.headers };
}
async function human(name: string) {
  const r = await req("POST", "/auth/register", undefined, {
    name,
    email: `${crypto.randomUUID()}@example.test`,
    password: "synthetic-test-password",
  });
  expect(r.status).toBe(200);
  userIds.push(r.body.user.id);
  return { id: r.body.user.id, token: r.body.accessToken, name };
}
async function dm(userId: string) {
  const [conversation] = await db
    .insert(conversations)
    .values({ type: "direct", workspaceId })
    .returning();
  await db.insert(conversationParticipants).values([
    { conversationId: conversation.id, userId },
    { conversationId: conversation.id, userId: bot.userId },
  ]);
  return conversation.id;
}
async function getSettings() {
  const r = await req("GET", settingsPath(), owner.token);
  expect(r.status).toBe(200);
  return r.body;
}
beforeAll(async () => {
  owner = await human("Settings Owner");
  member = await human("Selected Human");
  denied = await human("Unselected Human");
  foreign = await human("Foreign Human");
  const [w] = await db
    .insert(workspaces)
    .values({
      id: crypto.randomUUID(),
      name: "Settings fixture",
      createdById: owner.id,
    })
    .returning();
  workspaceId = w.id;
  workspaceIds.push(w.id);
  await db
    .insert(workspaceMembers)
    .values(
      [owner, member, denied].map((u) => ({
        workspaceId,
        userId: u.id,
        role: u === owner ? ("owner" as const) : ("member" as const),
      })),
    );
  const r = await req("POST", "/bots/create", owner.token, {
    name: "Direct fixture",
    kind: "hermes-rpc",
    workspaceId,
    hermesRpc: {
      endpoint: "http://127.0.0.1:9119",
      gatewayToken: "initial-synthetic-gateway-token",
    },
  });
  expect(r.status).toBe(200);
  bot = r.body;
  userIds.push(bot.userId);
  ownerDm = await dm(owner.id);
  memberDm = await dm(member.id);
  const [f] = await db
    .insert(workspaces)
    .values({
      id: crypto.randomUUID(),
      name: "Foreign workspace",
      createdById: foreign.id,
    })
    .returning();
  workspaceIds.push(f.id);
  await db
    .insert(workspaceMembers)
    .values(
      [bot.userId, foreign.id].map((userId) => ({
        workspaceId: f.id,
        userId,
        role: "member" as const,
      })),
    );
});
afterAll(async () => {
  if (workspaceIds.length)
    await db.delete(workspaces).where(inArray(workspaces.id, workspaceIds));
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
  await getHermesProxyTicketStore().close?.();
});

test("an unavailable selection cannot be retained after becoming nonhuman", async () => {
  const settings = await getSettings();
  expect(
    (
      await req("PATCH", settingsPath(), owner.token, {
        revision: settings.revision,
        allowedUserIds: [member.id],
        acknowledgeSharedAccess: true,
      })
    ).status,
  ).toBe(200);
  await db.update(users).set({ type: "bot" }).where(eq(users.id, member.id));
  try {
    const selected = await getSettings();
    expect(
      (
        await req("PATCH", settingsPath(), owner.token, {
          revision: selected.revision,
          allowedUserIds: [member.id],
        })
      ).status,
    ).toBe(400);
  } finally {
    await db
      .update(users)
      .set({ type: "human" })
      .where(eq(users.id, member.id));
    const current = await getSettings();
    expect(
      (
        await req("PATCH", settingsPath(), owner.token, {
          revision: current.revision,
          allowedUserIds: [],
        })
      ).status,
    ).toBe(200);
  }
});

test("malformed bot identifiers fail with safe 400 responses", async () => {
  for (const method of ["GET", "PATCH"]) {
    const r = await req(
      method,
      "/bots/not-a-uuid/hermes-rpc/settings",
      owner.token,
      method === "PATCH" ? { revision: "1" } : undefined,
    );
    expect(r.status).toBe(400);
    expect(r.headers.get("cache-control")).toBe("no-store");
  }
});

test("removing the bot owner from the DM workspace denies fresh shared tickets", async () => {
  const settings = await getSettings();
  expect(
    (
      await req("PATCH", settingsPath(), owner.token, {
        revision: settings.revision,
        allowedUserIds: [member.id],
        acknowledgeSharedAccess: true,
      })
    ).status,
  ).toBe(200);
  await db
    .update(workspaceMembers)
    .set({ role: "member" })
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, owner.id),
      ),
    );
  await db
    .update(workspaceMembers)
    .set({ role: "admin" })
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, denied.id),
      ),
    );
  try {
    await removeMember(workspaceId, denied.id, owner.id);
    expect(
      (
        await req(
          "POST",
          `/bots/${bot.id}/hermes-rpc/proxy-ticket`,
          member.token,
          { conversationId: memberDm },
        )
      ).status,
    ).toBe(403);
  } finally {
    await db
      .insert(workspaceMembers)
      .values({ workspaceId, userId: owner.id, role: "owner" })
      .onConflictDoNothing();
    await db
      .update(workspaceMembers)
      .set({ role: "member" })
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, denied.id),
        ),
      );
    const current = await getSettings();
    expect(
      (
        await req("PATCH", settingsPath(), owner.token, {
          revision: current.revision,
          allowedUserIds: [],
        })
      ).status,
    ).toBe(200);
  }
});

test("Redis outage fails ticket issuance and rolls back settings and member removal", async () => {
  const before = await getSettings();
  const selected = await req("PATCH", settingsPath(), owner.token, {
    revision: before.revision,
    allowedUserIds: [member.id],
    acknowledgeSharedAccess: true,
  });
  expect(selected.status).toBe(200);
  const unavailable = new Redis("redis://127.0.0.1:1", {
    lazyConnect: true,
    connectTimeout: 100,
    commandTimeout: 100,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  unavailable.on("error", () => {});
  await setHermesProxyTicketStoreForTests(
    new RedisHermesProxyTicketStore({ redis: unavailable }),
  );
  try {
    const failed = await req("PATCH", settingsPath(), owner.token, {
      revision: selected.body.revision,
      gatewayToken: "must-not-save",
    });
    expect(failed.status).toBe(503);
    expect((await getSettings()).revision).toBe(selected.body.revision);
    expect(
      (
        await req(
          "POST",
          `/bots/${bot.id}/hermes-rpc/proxy-ticket`,
          owner.token,
          { conversationId: ownerDm },
        )
      ).status,
    ).toBe(503);
    await expect(
      removeMember(workspaceId, owner.id, member.id),
    ).rejects.toMatchObject({ status: 503 });
    const membership = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, member.id),
        ),
      );
    expect(membership).toHaveLength(1);
  } finally {
    await setHermesProxyTicketStoreForTests(null);
    unavailable.disconnect();
    const current = await getSettings();
    expect(
      (
        await req("PATCH", settingsPath(), owner.token, {
          revision: current.revision,
          allowedUserIds: [],
        })
      ).status,
    ).toBe(200);
  }
});

test("CAS allows exactly one concurrent edit", async () => {
  const current = await getSettings();
  const results = await Promise.all(
    ["cas-one", "cas-two"].map((gatewayToken) =>
      req("PATCH", settingsPath(), owner.token, {
        revision: current.revision,
        gatewayToken,
      }),
    ),
  );
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
});

test("a ticket waiting for settings commit rechecks the revoked grant", async () => {
  const current = await getSettings();
  const selected = await req("PATCH", settingsPath(), owner.token, {
    revision: current.revision,
    allowedUserIds: [member.id],
    acknowledgeSharedAccess: true,
  });
  const store = getHermesProxyTicketStore();
  const publish = store.publishPolicyRevision.bind(store);
  let entered!: () => void, release!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  store.publishPolicyRevision = async (id, revision) => {
    await publish(id, revision);
    entered();
    await gate;
  };
  const saving = req("PATCH", settingsPath(), owner.token, {
    revision: selected.body.revision,
    allowedUserIds: [],
  });
  try {
    await enteredPromise;
    const ticket = req(
      "POST",
      `/bots/${bot.id}/hermes-rpc/proxy-ticket`,
      member.token,
      { conversationId: memberDm },
    );
    expect(
      await Promise.race([
        ticket.then(() => "issued"),
        Bun.sleep(50).then(() => "waiting"),
      ]),
    ).toBe("waiting");
    release();
    expect((await saving).status).toBe(200);
    expect((await ticket).status).toBe(403);
  } finally {
    release();
    await saving;
    store.publishPolicyRevision = publish;
  }
});

for (const mutation of [
  "access",
  "token",
  "endpoint",
  "member",
  "bot",
] as const) {
  test(`real API/Redis/proxy ${mutation} change closes the selected human tunnel`, async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) return;
        return new Response("upgrade", { status: 426 });
      },
      websocket: {
        message(socket, frame) {
          socket.send(frame);
        },
      },
    });
    const proxyStore = new RedisHermesProxyTicketStore();
    const proxy = createHermesProxyServer({
      hostname: "127.0.0.1",
      port: 0,
      ticketStore: proxyStore,
    });
    let socket: WebSocket | undefined;
    try {
      const settings = await getSettings();
      const configured = await req("PATCH", settingsPath(), owner.token, {
        revision: settings.revision,
        endpoint: `http://127.0.0.1:${upstream.port}`,
        gatewayToken: "active-test-secret",
        allowedUserIds: [member.id],
        acknowledgeSharedAccess: true,
      });
      expect(configured.status).toBe(200);
      const ticketPath = `/bots/${bot.id}/hermes-rpc/proxy-ticket`;
      const issued = await req("POST", ticketPath, member.token, {
        conversationId: memberDm,
      });
      const unused = await req("POST", ticketPath, member.token, {
        conversationId: memberDm,
      });
      expect(issued.status).toBe(200);
      expect(unused.status).toBe(200);
      socket = new WebSocket(`ws://127.0.0.1:${proxy.port}/hermes-proxy`, [
        HERMES_PROXY_PROTOCOL,
        hermesProxyTicketProtocol(issued.body.ticket),
      ]);
      await new Promise<void>((resolve, reject) => {
        socket!.onopen = () => resolve();
        socket!.onerror = () => reject(new Error("connection failed"));
      });
      const echo = new Promise<MessageEvent>((resolve) => {
        socket!.onmessage = resolve;
      });
      socket.send("opaque-not-json");
      expect((await echo).data).toBe("opaque-not-json");
      const closed = new Promise<CloseEvent>((resolve) => {
        socket!.onclose = resolve;
      });
      if (mutation === "member")
        await removeMember(workspaceId, owner.id, member.id);
      else if (mutation === "bot")
        await removeBotFromWorkspace(bot.id, workspaceId, owner.id);
      else {
        const update =
          mutation === "access"
            ? { allowedUserIds: [] }
            : mutation === "token"
              ? { gatewayToken: "rotated-active-secret" }
              : {
                  endpoint: "http://127.0.0.1:9119",
                  gatewayToken: "new-endpoint-secret",
                };
        expect(
          (
            await req("PATCH", settingsPath(), owner.token, {
              revision: configured.body.revision,
              ...update,
            })
          ).status,
        ).toBe(200);
      }
      expect(await proxyStore.consume(unused.body.ticket)).toBeNull();
      const event = await Promise.race([
        closed,
        Bun.sleep(3500).then(() => null),
      ]);
      expect(event?.code).toBe(1008);
      expect(event?.reason).toBe("Hermes proxy authorization revoked");
      if (["access", "member", "bot"].includes(mutation))
        expect(
          (
            await req("POST", ticketPath, member.token, {
              conversationId: memberDm,
            })
          ).status,
        ).toBe(403);
    } finally {
      socket?.close();
      proxy.stop(true);
      upstream.stop(true);
      await proxyStore.close();
      await db
        .insert(workspaceMembers)
        .values(
          [member.id, bot.userId].map((userId) => ({
            workspaceId,
            userId,
            role: "member" as const,
          })),
        )
        .onConflictDoNothing();
      await db
        .insert(conversationParticipants)
        .values(
          [ownerDm, memberDm].map((conversationId) => ({
            conversationId,
            userId: bot.userId,
          })),
        )
        .onConflictDoNothing();
      const current = await getSettings();
      expect(
        (
          await req("PATCH", settingsPath(), owner.token, {
            revision: current.revision,
            endpoint: "http://127.0.0.1:9119",
            gatewayToken: "restored-synthetic-token",
            allowedUserIds: [],
          })
        ).status,
      ).toBe(200);
    }
  });
}

for (const removal of ["member", "bot"] as const) {
  test(`${removal} removal denies fresh tickets, revokes old tickets and hides unavailable names`, async () => {
    const before = await getSettings();
    expect(
      (
        await req("PATCH", settingsPath(), owner.token, {
          revision: before.revision,
          allowedUserIds: [member.id],
          acknowledgeSharedAccess: true,
        })
      ).status,
    ).toBe(200);
    const ticketPath = `/bots/${bot.id}/hermes-rpc/proxy-ticket`;
    const issued = await req("POST", ticketPath, member.token, {
      conversationId: memberDm,
    });
    expect(issued.status).toBe(200);
    try {
      if (removal === "member")
        await removeMember(workspaceId, owner.id, member.id);
      else await removeBotFromWorkspace(bot.id, workspaceId, owner.id);
      expect(
        (
          await req("POST", ticketPath, member.token, {
            conversationId: memberDm,
          })
        ).status,
      ).toBe(403);
      expect(
        await getHermesProxyTicketStore().consume(issued.body.ticket),
      ).toBeNull();
      const settings = await getSettings();
      expect(settings.allowedUserIds).toEqual([member.id]);
      expect(settings.eligibleUsers.some((u: any) => u.id === member.id)).toBe(
        false,
      );
      expect(
        (
          await req("PATCH", settingsPath(), owner.token, {
            revision: settings.revision,
            allowedUserIds: [],
          })
        ).status,
      ).toBe(200);
    } finally {
      await db
        .insert(workspaceMembers)
        .values({
          workspaceId,
          userId: removal === "member" ? member.id : bot.userId,
          role: "member",
        })
        .onConflictDoNothing();
      if (removal === "bot") {
        await db
          .insert(conversationParticipants)
          .values(
            [ownerDm, memberDm].map((conversationId) => ({
              conversationId,
              userId: bot.userId,
            })),
          )
          .onConflictDoNothing();
      }
    }
  });
}

test("rejects unsafe settings, invalid grants and missing shared-access acknowledgement without writes", async () => {
  const before = await getSettings();
  const invalid = [
    { allowedUserIds: [member.id] },
    { allowedUserIds: [member.id], acknowledgeSharedAccess: false },
    { allowedUserIds: [member.id, member.id], acknowledgeSharedAccess: true },
    ...[owner.id, bot.userId, foreign.id, crypto.randomUUID(), "not-an-id"].map(
      (id) => ({ allowedUserIds: [id], acknowledgeSharedAccess: true }),
    ),
    { allowedUserIds: "everyone" },
    { allowedUserIds: null },
    { unknown: true },
    { endpoint: "http://unapproved.example", gatewayToken: "new-token" },
    { endpoint: "http://user:pass@127.0.0.1:9119", gatewayToken: "new-token" },
    { endpoint: "http://127.0.0.1:9119?token=bad", gatewayToken: "new-token" },
    { endpoint: "http://127.0.0.1:9220" },
    { endpoint: "http://127.0.0.1:9220", gatewayToken: "" },
    { endpoint: "" },
    { gatewayToken: null },
    { gatewayToken: "bad\ntoken" },
    { gatewayToken: "bad token" },
    { gatewayToken: "x".repeat(4097) },
  ];
  for (const update of invalid) {
    const r = await req("PATCH", settingsPath(), owner.token, {
      revision: before.revision,
      ...update,
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain("bad\\ntoken");
  }
  expect((await getSettings()).revision).toBe(before.revision);
  for (const gatewayToken of [
    "bad\ntoken",
    "bad token",
    "",
    "x".repeat(4097),
  ]) {
    const created = await req("POST", "/bots/create", owner.token, {
      name: "Invalid token",
      kind: "hermes-rpc",
      workspaceId,
      hermesRpc: { endpoint: "http://127.0.0.1:9119", gatewayToken },
    });
    if (created.body.userId) userIds.push(created.body.userId);
    expect(created.status).toBe(400);
  }
});

test("settings changes invalidate tickets already issued to the same gateway", async () => {
  const before = await getSettings();
  const issued = await req(
    "POST",
    `/bots/${bot.id}/hermes-rpc/proxy-ticket`,
    owner.token,
    { conversationId: ownerDm },
  );
  expect(issued.status).toBe(200);
  expect(
    (
      await req("PATCH", settingsPath(), owner.token, {
        revision: before.revision,
        gatewayToken: "revocation-test-secret",
      })
    ).status,
  ).toBe(200);
  expect(
    await getHermesProxyTicketStore().consume(issued.body.ticket),
  ).toBeNull();
});

test("explicitly selected human can use only their own bot DM, not settings", async () => {
  const ticketPath = `/bots/${bot.id}/hermes-rpc/proxy-ticket`;
  expect(
    (await req("POST", ticketPath, member.token, { conversationId: memberDm }))
      .status,
  ).toBe(403);
  const before = await getSettings();
  const update = {
    revision: before.revision,
    allowedUserIds: [member.id],
    acknowledgeSharedAccess: true,
  };
  const saved = await req("PATCH", settingsPath(), owner.token, update);
  expect(saved.status).toBe(200);
  expect(saved.body.allowedUserIds).toEqual([member.id]);
  for (const u of [owner, member]) {
    const issued = await req("POST", ticketPath, u.token, {
      conversationId: u === owner ? ownerDm : memberDm,
    });
    expect(issued.status).toBe(200);
    expect(
      await getHermesProxyTicketStore().consume(issued.body.ticket),
    ).toMatchObject({ userId: u.id, botId: bot.id });
  }
  expect(
    (await req("POST", ticketPath, member.token, { conversationId: ownerDm }))
      .status,
  ).toBe(403);
  expect(
    (
      await req("POST", ticketPath, denied.token, {
        conversationId: await dm(denied.id),
      })
    ).status,
  ).toBe(403);
  for (const u of [member, denied, foreign]) {
    expect((await req("GET", settingsPath(), u.token)).status).toBe(403);
    expect(
      (
        await req("PATCH", settingsPath(), u.token, {
          revision: saved.body.revision,
        })
      ).status,
    ).toBe(403);
  }
  for (const method of ["GET", "PATCH"])
    expect(
      (
        await req(
          method,
          settingsPath(),
          bot.apiKey,
          method === "PATCH" ? { revision: saved.body.revision } : undefined,
        )
      ).status,
    ).toBe(401);
  expect(
    (await req("POST", ticketPath, bot.apiKey, { conversationId: memberDm }))
      .status,
  ).toBe(401);
  expect(
    (
      await req("PATCH", settingsPath(), owner.token, {
        revision: saved.body.revision,
        allowedUserIds: [],
      })
    ).status,
  ).toBe(200);
});

test("owner replaces encrypted token with CAS; omission and blank preserve it", async () => {
  const before = await getSettings();
  const r = await req("PATCH", settingsPath(), owner.token, {
    revision: before.revision,
    gatewayToken: "replacement-synthetic-secret",
  });
  expect(r.status).toBe(200);
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(r.body.revision).not.toBe(before.revision);
  expect(JSON.stringify(r.body)).not.toContain("synthetic-secret");
  const [stored] = await db
    .select()
    .from(hermesRpcBotConfigs)
    .where(eq(hermesRpcBotConfigs.botId, bot.id));
  expect(decryptSecret(stored.gatewayTokenEncrypted)).toBe(
    "replacement-synthetic-secret",
  );
  expect(stored.gatewayTokenEncrypted).not.toContain(
    "replacement-synthetic-secret",
  );
  expect(
    (
      await req("PATCH", settingsPath(), owner.token, {
        revision: before.revision,
        gatewayToken: "stale-secret",
      })
    ).status,
  ).toBe(409);
  for (const update of [{}, { gatewayToken: "" }, { gatewayToken: "   " }]) {
    const current = await getSettings();
    expect(
      (
        await req("PATCH", settingsPath(), owner.token, {
          revision: current.revision,
          ...update,
        })
      ).status,
    ).toBe(200);
    const [retained] = await db
      .select()
      .from(hermesRpcBotConfigs)
      .where(eq(hermesRpcBotConfigs.botId, bot.id));
    expect(retained.gatewayTokenEncrypted).toBe(stored.gatewayTokenEncrypted);
  }
});

test("owner reads safe settings with only humans from owner/bot shared workspaces", async () => {
  const r = await req("GET", settingsPath(), owner.token);
  expect(r.status).toBe(200);
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(r.body).toEqual({
    botId: bot.id,
    endpoint: "ws://127.0.0.1:9119/api/ws",
    gatewayTokenConfigured: true,
    allowedUserIds: [],
    eligibleUsers: expect.arrayContaining([
      { id: member.id, name: member.name },
      { id: denied.id, name: denied.name },
    ]),
    revision: expect.any(String),
  });
  expect(r.body.eligibleUsers).toHaveLength(2);
  expect(JSON.stringify(r.body)).not.toContain("initial-synthetic");
});
