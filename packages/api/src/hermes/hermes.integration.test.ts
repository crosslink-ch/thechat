import { describe, test, expect, afterAll } from "bun:test";
import { Elysia } from "elysia";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { botInvocations, botSessions, users, workspaces, bots, hermesBotConfigs, messages } from "../db/schema";
import { authRoutes } from "../auth";
import { workspaceRoutes } from "../workspaces";
import { conversationRoutes } from "../conversations";
import { messageRoutes } from "../messages";
import { botRoutes } from "../bots";
import { hermesRoutes } from "./index";
import { botRuntimeRoutes } from "../bot-runtime";
import { closeBotRuntimeForTests } from "../services/bot-runtime";
import crypto from "crypto";

const app = new Elysia()
  .use(authRoutes)
  .use(workspaceRoutes)
  .use(conversationRoutes)
  .use(messageRoutes)
  .use(botRoutes)
  .use(hermesRoutes)
  .use(botRuntimeRoutes);

const createdUserEmails: string[] = [];
const createdWorkspaceIds: string[] = [];
const createdBotUserIds: string[] = [];

afterAll(async () => {
  await closeBotRuntimeForTests();
  for (const id of createdBotUserIds) {
    await db.delete(users).where(eq(users.id, id));
  }
  for (const id of createdWorkspaceIds) {
    await db.delete(workspaces).where(eq(workspaces.id, id));
  }
  for (const email of createdUserEmails) {
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (user) await db.delete(users).where(eq(users.id, user.id));
  }
});

function uniqueEmail() {
  return `hermes-${crypto.randomUUID()}@test.com`;
}

async function req(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );
  const text = await response.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch {}
  return { status: response.status, body: json };
}

async function registerUser(name: string) {
  const email = uniqueEmail();
  createdUserEmails.push(email);
  const res = await req("POST", "/auth/register", { name, email, password: "password123" });
  return { token: res.body.accessToken as string, user: res.body.user };
}

async function createWorkspace(token: string, name: string) {
  const res = await req("POST", "/workspaces/create", { name }, token);
  expect(res.status).toBe(200);
  createdWorkspaceIds.push(res.body.id);
  return res.body;
}

function startFakeHermes() {
  const calls: Array<{ path: string; body?: unknown; auth: string | null }> = [];
  let runCount = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      calls.push({
        path: url.pathname,
        auth: request.headers.get("authorization"),
        body: request.method === "POST" ? await request.json().catch(() => undefined) : undefined,
      });
      if (url.pathname === "/health") return Response.json({ status: "ok" });
      if (url.pathname === "/v1/capabilities") return Response.json({ capabilities: ["runs", "responses"] });
      if (url.pathname === "/v1/runs" && request.method === "POST") {
        runCount += 1;
        return Response.json({ run_id: `fake-run-${runCount}`, status: "queued" });
      }
      if (/^\/v1\/runs\/fake-run-\d+\/events$/.test(url.pathname)) {
        return new Response(
          [
            "event: run_started",
            'data: {"run_id":"fake-run-1"}',
            "",
            "event: done",
            'data: {"final_output":"Hermes says hello from fake Docker runtime"}',
            "",
          ].join("\n"),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  return { server, baseUrl: `http://localhost:${server.port}`, calls };
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 5000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for condition");
}

describe("Hermes bot routes and mention flow", () => {
  test("rejects Hermes connection settings during generic bot creation", async () => {
    const human = await registerUser("HermesConnectSeparate");
    const workspace = await createWorkspace(human.token, "Hermes Connect Separate WS");

    const createRes = await req(
      "POST",
      "/bots/create",
      {
        kind: "hermes",
        workspaceId: workspace.id,
        name: "Hermes",
        hermes: {
          baseUrl: "http://localhost:18642",
          apiKey: "dev-hermes-key",
        },
      },
      human.token,
    );

    expect(createRes.status).toBe(400);
    expect(createRes.body.error).toContain("/bots/:botId/hermes");
  });

  test("workspace admin creates and tests a Hermes bot without exposing API key", async () => {
    const hermes = startFakeHermes();
    try {
      const human = await registerUser("HermesOwner");
      const workspace = await createWorkspace(human.token, "Hermes Workspace");

      const createRes = await req(
        "POST",
        "/bots/create",
        {
          kind: "hermes",
          workspaceId: workspace.id,
          name: "Hermes",
        },
        human.token,
      );

      expect(createRes.status).toBe(200);
      expect(createRes.body.kind).toBe("hermes");
      expect(createRes.body.apiKey).toBeUndefined();
      createdBotUserIds.push(createRes.body.userId);

      const connectRes = await req(
        "PATCH",
        `/bots/${createRes.body.id}/hermes`,
        {
          baseUrl: hermes.baseUrl,
          apiKey: "dev-hermes-key",
          defaultInstructions: "Keep replies concise.",
        },
        human.token,
      );
      expect(connectRes.status).toBe(200);
      expect(connectRes.body.apiKey).toBeUndefined();

      const [botRow] = await db.select({ kind: bots.kind }).from(bots).where(eq(bots.id, createRes.body.id));
      expect(botRow.kind).toBe("hermes");

      const [configRow] = await db
        .select({ baseUrl: hermesBotConfigs.baseUrl, apiKey: hermesBotConfigs.apiKeyEncrypted })
        .from(hermesBotConfigs)
        .where(eq(hermesBotConfigs.botId, createRes.body.id));
      expect(configRow.baseUrl).toBe(hermes.baseUrl);
      expect(configRow.apiKey).not.toBe("dev-hermes-key");

      const testRes = await req("POST", `/bots/${createRes.body.id}/hermes/test`, {}, human.token);
      expect(testRes.status).toBe(200);
      expect(testRes.body.health.status).toBe("ok");
      expect(testRes.body.capabilities.capabilities).toContain("runs");
    } finally {
      hermes.server.stop(true);
    }
  });

  test("mentioning a Hermes bot starts a run and posts the final bot message", async () => {
    const hermes = startFakeHermes();
    try {
      const human = await registerUser("MentionOwner");
      const workspace = await createWorkspace(human.token, "Hermes Mention WS");
      const createRes = await req(
        "POST",
        "/bots/create",
        {
          kind: "hermes",
          workspaceId: workspace.id,
          name: "Koda",
        },
        human.token,
      );
      expect(createRes.status).toBe(200);
      createdBotUserIds.push(createRes.body.userId);
      const connectRes = await req(
        "PATCH",
        `/bots/${createRes.body.id}/hermes`,
        {
          baseUrl: hermes.baseUrl,
          apiKey: "dev-hermes-key",
          defaultInstructions: "You are Koda in TheChat.",
        },
        human.token,
      );
      expect(connectRes.status).toBe(200);

      const detailRes = await req("GET", `/workspaces/${workspace.id}`, undefined, human.token);
      const channelId = detailRes.body.channels[0].id;

      const sendRes = await req("POST", `/messages/${channelId}`, { content: "@Koda say hello" }, human.token);
      expect(sendRes.status).toBe(200);

      await waitFor(async () => {
        const rows = await db
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, channelId),
              eq(messages.senderId, createRes.body.userId),
              eq(messages.content, "Hermes says hello from fake Docker runtime"),
            ),
          );
        return rows[0] ?? null;
      });

      const messagesRes = await req("GET", `/messages/${channelId}`, undefined, human.token);
      const final = messagesRes.body.find((m: any) => m.senderName === "Koda" && m.content.includes("Hermes says hello"));
      expect(final).toBeDefined();
      expect(final.senderType).toBe("bot");

      const runCall = hermes.calls.find((c) => c.path === "/v1/runs");
      expect(runCall?.auth).toBe("Bearer dev-hermes-key");
      expect((runCall?.body as any).input).toBe("say hello");
      expect((runCall?.body as any).session_id).toContain(`thechat:workspace:${workspace.id}:conversation:${channelId}:bot:${createRes.body.id}`);

      const runtimeRes = await req("GET", `/bot-runtime/conversations/${channelId}`, undefined, human.token);
      expect(runtimeRes.status).toBe(200);
      expect(runtimeRes.body.sessions).toHaveLength(1);
      expect(runtimeRes.body.sessions[0].botName).toBe("Koda");
      expect(runtimeRes.body.invocations[0].status).toBe("completed");
      expect(runtimeRes.body.invocations[0].externalRunId).toBe("fake-run-1");
      expect(runtimeRes.body.events.some((event: any) => event.type === "hermes.done")).toBe(true);
    } finally {
      hermes.server.stop(true);
    }
  });

  test("direct messages to a workspace Hermes bot start a run without a mention", async () => {
    const hermes = startFakeHermes();
    try {
      const human = await registerUser("DirectHermesOwner");
      const workspace = await createWorkspace(human.token, "Hermes Direct WS");
      const createRes = await req(
        "POST",
        "/bots/create",
        {
          kind: "hermes",
          workspaceId: workspace.id,
          name: "DirectKoda",
        },
        human.token,
      );
      expect(createRes.status).toBe(200);
      createdBotUserIds.push(createRes.body.userId);

      const novaRes = await req(
        "POST",
        "/bots/create",
        {
          kind: "hermes",
          workspaceId: workspace.id,
          name: "NovaDirect",
        },
        human.token,
      );
      expect(novaRes.status).toBe(200);
      createdBotUserIds.push(novaRes.body.userId);

      const connectNovaRes = await req(
        "PATCH",
        `/bots/${novaRes.body.id}/hermes`,
        {
          baseUrl: hermes.baseUrl,
          apiKey: "dev-hermes-key",
          defaultInstructions: "You are NovaDirect in TheChat.",
        },
        human.token,
      );
      expect(connectNovaRes.status).toBe(200);

      const connectRes = await req(
        "PATCH",
        `/bots/${createRes.body.id}/hermes`,
        {
          baseUrl: hermes.baseUrl,
          apiKey: "dev-hermes-key",
          defaultInstructions: "You are DirectKoda in TheChat.",
        },
        human.token,
      );
      expect(connectRes.status).toBe(200);

      const dmRes = await req(
        "POST",
        "/conversations/dm",
        { workspaceId: workspace.id, otherUserId: createRes.body.userId },
        human.token,
      );
      expect(dmRes.status).toBe(200);

      const sendRes = await req("POST", `/messages/${dmRes.body.id}`, { content: "say hello from the DM" }, human.token);
      expect(sendRes.status).toBe(200);

      await waitFor(async () => {
        const rows = await db
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, dmRes.body.id),
              eq(messages.senderId, createRes.body.userId),
              eq(messages.content, "Hermes says hello from fake Docker runtime"),
            ),
          );
        return rows[0] ?? null;
      });

      const messagesRes = await req("GET", `/messages/${dmRes.body.id}`, undefined, human.token);
      const final = messagesRes.body.find((m: any) => m.senderName === "DirectKoda" && m.content.includes("Hermes says hello"));
      expect(final).toBeDefined();
      expect(messagesRes.body.some((m: any) => m.senderName === "NovaDirect")).toBe(false);

      const runCalls = hermes.calls.filter((c) => c.path === "/v1/runs");
      expect(runCalls).toHaveLength(1);
      const runCall = runCalls[0];
      expect(runCall?.auth).toBe("Bearer dev-hermes-key");
      expect((runCall?.body as any).input).toBe("say hello from the DM");
      expect((runCall?.body as any).session_id).toContain(`thechat:workspace:${workspace.id}:conversation:${dmRes.body.id}:bot:${createRes.body.id}`);

      const followupRes = await req("POST", `/messages/${dmRes.body.id}`, { content: "what did I ask before?" }, human.token);
      expect(followupRes.status).toBe(200);

      await waitFor(async () => {
        const rows = await db
          .select({ id: botInvocations.id })
          .from(botInvocations)
          .where(
            and(
              eq(botInvocations.conversationId, dmRes.body.id),
              eq(botInvocations.botId, createRes.body.id),
              eq(botInvocations.status, "completed"),
            ),
          );
        return rows.length >= 2 ? rows : null;
      });

      const runtimeRes = await req("GET", `/bot-runtime/conversations/${dmRes.body.id}`, undefined, human.token);
      expect(runtimeRes.status).toBe(200);
      expect(runtimeRes.body.sessions).toHaveLength(1);
      expect(runtimeRes.body.sessions[0].botName).toBe("DirectKoda");
      expect(runtimeRes.body.invocations.filter((inv: any) => inv.botName === "DirectKoda")).toHaveLength(2);

      const [sessionRow] = await db
        .select({ externalSessionId: botSessions.externalSessionId, lastMessageId: botSessions.lastMessageId })
        .from(botSessions)
        .where(eq(botSessions.conversationId, dmRes.body.id));
      expect(sessionRow.externalSessionId).toContain(`conversation:${dmRes.body.id}`);
      expect(sessionRow.lastMessageId).toBeTruthy();

      const secondRunCall = hermes.calls.filter((c) => c.path === "/v1/runs")[1];
      expect((secondRunCall?.body as any).input).toBe("what did I ask before?");
      expect((secondRunCall?.body as any).conversation_history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "user", content: "say hello from the DM" }),
          expect.objectContaining({ role: "assistant", content: "Hermes says hello from fake Docker runtime" }),
        ]),
      );
    } finally {
      hermes.server.stop(true);
    }
  });
});
