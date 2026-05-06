import { describe, test, expect, afterAll } from "bun:test";
import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users, workspaces, bots, hermesBotConfigs, messages } from "../db/schema";
import { authRoutes } from "../auth";
import { workspaceRoutes } from "../workspaces";
import { conversationRoutes } from "../conversations";
import { messageRoutes } from "../messages";
import { botRoutes } from "../bots";
import { hermesRoutes } from "./index";
import crypto from "crypto";

const app = new Elysia()
  .use(authRoutes)
  .use(workspaceRoutes)
  .use(conversationRoutes)
  .use(messageRoutes)
  .use(botRoutes)
  .use(hermesRoutes);

const createdUserEmails: string[] = [];
const createdWorkspaceIds: string[] = [];
const createdBotUserIds: string[] = [];

afterAll(async () => {
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
        return Response.json({ run_id: "fake-run-1", status: "queued" });
      }
      if (url.pathname === "/v1/runs/fake-run-1/events") {
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
          hermes: {
            baseUrl: hermes.baseUrl,
            apiKey: "dev-hermes-key",
            defaultInstructions: "Keep replies concise.",
          },
        },
        human.token,
      );

      expect(createRes.status).toBe(200);
      expect(createRes.body.bot.kind).toBe("hermes");
      expect(createRes.body.bot.apiKey).toBeUndefined();
      expect(createRes.body.config.apiKey).toBeUndefined();
      createdBotUserIds.push(createRes.body.bot.userId);

      const [botRow] = await db.select({ kind: bots.kind }).from(bots).where(eq(bots.id, createRes.body.bot.id));
      expect(botRow.kind).toBe("hermes");

      const [configRow] = await db
        .select({ baseUrl: hermesBotConfigs.baseUrl, apiKey: hermesBotConfigs.apiKeyEncrypted })
        .from(hermesBotConfigs)
        .where(eq(hermesBotConfigs.botId, createRes.body.bot.id));
      expect(configRow.baseUrl).toBe(hermes.baseUrl);
      expect(configRow.apiKey).not.toBe("dev-hermes-key");

      const testRes = await req("POST", `/bots/${createRes.body.bot.id}/hermes/test`, {}, human.token);
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
          hermes: {
            baseUrl: hermes.baseUrl,
            apiKey: "dev-hermes-key",
            defaultInstructions: "You are Koda in TheChat.",
          },
        },
        human.token,
      );
      createdBotUserIds.push(createRes.body.bot.userId);

      const detailRes = await req("GET", `/workspaces/${workspace.id}`, undefined, human.token);
      const channelId = detailRes.body.channels[0].id;

      const sendRes = await req("POST", `/messages/${channelId}`, { content: "@Koda say hello" }, human.token);
      expect(sendRes.status).toBe(200);

      await waitFor(async () => {
        const rows = await db
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.content, "Hermes says hello from fake Docker runtime"));
        return rows[0] ?? null;
      });

      const messagesRes = await req("GET", `/messages/${channelId}`, undefined, human.token);
      const final = messagesRes.body.find((m: any) => m.senderName === "Koda" && m.content.includes("Hermes says hello"));
      expect(final).toBeDefined();
      expect(final.senderType).toBe("bot");

      const runCall = hermes.calls.find((c) => c.path === "/v1/runs");
      expect(runCall?.auth).toBe("Bearer dev-hermes-key");
      expect((runCall?.body as any).input).toBe("say hello");
      expect((runCall?.body as any).session_id).toContain(`thechat:workspace:${workspace.id}:conversation:${channelId}:bot:${createRes.body.bot.id}`);
    } finally {
      hermes.server.stop(true);
    }
  });
});
