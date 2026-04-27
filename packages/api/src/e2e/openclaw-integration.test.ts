/**
 * End-to-end integration test: TheChat API <-> OpenClaw channel plugin.
 *
 * Validates the full round-trip:
 *   1. TheChat API runs on a real HTTP port.
 *   2. A "bot backend" server (simulating an OpenClaw instance) uses the
 *      actual @thechat/openclaw-channel plugin code to:
 *        a. Receive and verify signed webhooks from TheChat.
 *        b. Parse inbound messages via `handleInbound()`.
 *        c. Generate a deterministic response.
 *        d. Send the response back to TheChat via the plugin's `sendText()`.
 *   3. A human user sends a DM to the bot.
 *   4. The test polls until the bot's response message appears.
 *
 * Prerequisites:
 *   - DATABASE_URL must be set (same Postgres used for dev/test).
 *   - Opt-in: set OPENCLAW_E2E=1 to run (skipped in normal test suite).
 *
 * Run:
 *   OPENCLAW_E2E=1 bun test --env-file ../../.env --timeout 90000 src/e2e/openclaw-integration.test.ts
 *
 * Or via the package script:
 *   pnpm --filter @thechat/api test:e2e:openclaw
 */

import { describe, test, expect, afterAll } from "bun:test";
import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users, workspaces } from "../db/schema";
import { authRoutes } from "../auth";
import { workspaceRoutes } from "../workspaces";
import { conversationRoutes } from "../conversations";
import { messageRoutes } from "../messages";
import { botRoutes } from "../bots/index";

// Channel plugin sub-path imports — these modules have zero dependency on the
// `openclaw` peer package, so they resolve cleanly in the test environment.
import { handleInbound } from "@thechat/openclaw-channel/inbound";
import { sendText } from "@thechat/openclaw-channel/outbound";
import type { TheChatChannelConfig } from "@thechat/openclaw-channel/types";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TEST_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 250;
const RESPONSE_TIMEOUT_MS = 60_000;
const HUMAN_MESSAGE = "Hello bot, are you there?";

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function http(
  url: string,
  method: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

// ---------------------------------------------------------------------------
// Test state & cleanup
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Elysia's complex generics are impractical to spell out here
let theChatApp: any = null;
let botBackend: ReturnType<typeof Bun.serve> | null = null;

const createdUserEmails: string[] = [];
const createdWorkspaceIds: string[] = [];
const createdBotUserIds: string[] = [];

afterAll(async () => {
  try { botBackend?.stop(); } catch {}
  try { theChatApp?.stop(); } catch {}

  for (const id of createdBotUserIds) {
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
  for (const id of createdWorkspaceIds) {
    await db.delete(workspaces).where(eq(workspaces.id, id)).catch(() => {});
  }
  for (const email of createdUserEmails) {
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (user) {
      await db.delete(users).where(eq(users.id, user.id)).catch(() => {});
    }
  }
});

// ---------------------------------------------------------------------------
// Suite — skipped unless OPENCLAW_E2E=1
// ---------------------------------------------------------------------------

const suite = process.env.OPENCLAW_E2E === "1" ? describe : describe.skip;

suite("OpenClaw <-> TheChat E2E integration", () => {
  test(
    "human sends DM to bot -> webhook verified -> bot responds via channel plugin",
    async () => {
      // Observability flags — asserted at the end.
      let webhookReceived = false;
      let webhookVerified = false;
      let botResponseSent = false;

      // ---------------------------------------------------------------
      // 1. Start TheChat API on an ephemeral port
      // ---------------------------------------------------------------
      theChatApp = new Elysia()
        .use(cors())
        .use(authRoutes)
        .use(workspaceRoutes)
        .use(conversationRoutes)
        .use(messageRoutes)
        .use(botRoutes)
        .listen(0);

      const theChatUrl = `http://127.0.0.1:${theChatApp.server!.port as number}`;

      // ---------------------------------------------------------------
      // 2. Register a human user
      // ---------------------------------------------------------------
      const humanEmail = `e2e-${crypto.randomUUID()}@test.com`;
      createdUserEmails.push(humanEmail);

      const regRes = await http(`${theChatUrl}/auth/register`, "POST", {
        name: "E2E Human",
        email: humanEmail,
        password: "testpass123",
      });
      expect(regRes.status).toBe(200);
      const humanToken: string = regRes.body.accessToken;
      const humanUserId: string = regRes.body.user.id;

      // ---------------------------------------------------------------
      // 3. Create a workspace
      // ---------------------------------------------------------------
      const wsRes = await http(
        `${theChatUrl}/workspaces/create`,
        "POST",
        { name: `e2e-ws-${Date.now()}` },
        humanToken,
      );
      expect(wsRes.status).toBe(200);
      const workspaceId: string = wsRes.body.id;
      createdWorkspaceIds.push(workspaceId);

      // ---------------------------------------------------------------
      // 4. Create a bot (credentials returned immediately)
      // ---------------------------------------------------------------
      const botRes = await http(
        `${theChatUrl}/bots/create`,
        "POST",
        { name: "E2E OpenClaw Bot" },
        humanToken,
      );
      expect(botRes.status).toBe(200);
      const bot = botRes.body;
      expect(bot.apiKey).toStartWith("bot_");
      expect(bot.webhookSecret).toStartWith("whsec_");
      createdBotUserIds.push(bot.userId);

      // ---------------------------------------------------------------
      // 5. Start bot backend (simulates OpenClaw with channel plugin)
      // ---------------------------------------------------------------

      // Channel config mirrors what an OpenClaw operator would put in
      // their openclaw.json under channels.thechat.
      const channelConfig: TheChatChannelConfig = {
        baseUrl: theChatUrl,
        botId: bot.id,
        botUserId: bot.userId,
        botName: "E2E OpenClaw Bot",
        apiKey: bot.apiKey,
        webhookSecret: bot.webhookSecret,
      };

      botBackend = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
          if (request.method !== "POST") {
            return new Response("method not allowed", { status: 405 });
          }

          webhookReceived = true;
          const body = await request.text();
          const headers: Record<string, string> = {};
          for (const [k, v] of request.headers.entries()) {
            headers[k] = v;
          }

          // --- Use the actual channel plugin to verify & parse ---
          const outcome = handleInbound({ body, headers, config: channelConfig });

          if (outcome.kind === "rejected") {
            console.error(
              `[bot-backend] webhook rejected: ${outcome.reason}`,
            );
            return new Response(outcome.reason, { status: outcome.status });
          }
          if (outcome.kind === "skipped") {
            return new Response("skipped", { status: 204 });
          }

          // outcome.kind === "dispatched"
          webhookVerified = true;
          const userMessage = outcome.payload.message.content;

          const responseText = `Echo: ${userMessage}`;

          // --- Use the channel plugin outbound to send the reply ---
          try {
            await sendText({
              config: channelConfig,
              to: outcome.mapping.to,
              text: responseText,
            });
            botResponseSent = true;
          } catch (err: any) {
            console.error(
              `[bot-backend] sendText failed: ${err.message}`,
            );
          }

          return new Response("ok");
        },
      });

      // ---------------------------------------------------------------
      // 6. Update bot with the backend's webhook URL
      // ---------------------------------------------------------------
      const webhookUrl = `http://127.0.0.1:${botBackend.port}/webhook`;
      const updateRes = await http(
        `${theChatUrl}/bots/${bot.id}`,
        "PATCH",
        { webhookUrl },
        humanToken,
      );
      expect(updateRes.status).toBe(200);

      // ---------------------------------------------------------------
      // 7. Add bot to workspace
      // ---------------------------------------------------------------
      const addRes = await http(
        `${theChatUrl}/bots/${bot.id}/workspaces`,
        "POST",
        { workspaceId },
        humanToken,
      );
      expect(addRes.status).toBe(200);

      // ---------------------------------------------------------------
      // 8. Create DM between human and bot
      // ---------------------------------------------------------------
      const dmRes = await http(
        `${theChatUrl}/conversations/dm`,
        "POST",
        { workspaceId, otherUserId: bot.userId },
        humanToken,
      );
      expect(dmRes.status).toBe(200);
      const conversationId: string = dmRes.body.id;

      // ---------------------------------------------------------------
      // 9. Human sends a message
      // ---------------------------------------------------------------
      const sendRes = await http(
        `${theChatUrl}/messages/${conversationId}`,
        "POST",
        { content: HUMAN_MESSAGE },
        humanToken,
      );
      expect(sendRes.status).toBe(200);

      // ---------------------------------------------------------------
      // 10. Poll for the bot's response message
      // ---------------------------------------------------------------
      const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
      let botMessage: any = null;

      while (Date.now() < deadline) {
        const msgsRes = await http(
          `${theChatUrl}/messages/${conversationId}?limit=20`,
          "GET",
          undefined,
          humanToken,
        );

        if (msgsRes.status === 200 && Array.isArray(msgsRes.body)) {
          botMessage = msgsRes.body.find(
            (m: any) =>
              m.senderId === bot.userId && m.senderType === "bot",
          );
          if (botMessage) break;
        }

        await Bun.sleep(POLL_INTERVAL_MS);
      }

      // ---------------------------------------------------------------
      // 11. Assertions
      // ---------------------------------------------------------------
      expect(webhookReceived).toBe(true);
      expect(webhookVerified).toBe(true);
      expect(botResponseSent).toBe(true);
      expect(botMessage).toBeTruthy();
      expect(typeof botMessage.content).toBe("string");
      expect(botMessage.content.length).toBeGreaterThan(0);
      expect(botMessage.content).toBe(`Echo: ${HUMAN_MESSAGE}`);
      expect(botMessage.senderType).toBe("bot");
      expect(botMessage.senderId).toBe(bot.userId);

      console.log(`Bot responded: "${botMessage.content}"`);
      console.log("  (deterministic response)");
    },
    TEST_TIMEOUT_MS,
  );
});
