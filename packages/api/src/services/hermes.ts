import crypto from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  bots,
  conversationParticipants,
  hermesBotConfigs,
  messages,
  users,
  workspaceMembers,
} from "../db/schema";
import { createBot, addBotToWorkspace } from "./bots";
import { ServiceError } from "./errors";
import {
  getHermesCapabilities,
  getHermesHealth,
  startHermesRun,
  streamHermesRunEvents,
  type HermesConnection,
  type HermesRunEvent,
} from "./hermes-client";
import type { ChatMessage, WsServerEvent } from "@thechat/shared";

export type HermesDefaultMode = "run" | "response";
export type HermesSessionScope = "channel" | "thread" | "workspace";

function secretKey() {
  const secret =
    process.env.THECHAT_SECRET_KEY ??
    process.env.JWT_SECRET ??
    "thechat-local-development-secret-change-me";
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptSecret(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSecret(value: string) {
  if (!value.startsWith("v1:")) return value;
  const [, ivB64, tagB64, encryptedB64] = value.split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function toPublicConfig(row: typeof hermesBotConfigs.$inferSelect) {
  return {
    botId: row.botId,
    baseUrl: row.baseUrl,
    defaultMode: row.defaultMode as HermesDefaultMode,
    defaultInstructions: row.defaultInstructions,
    defaultSessionScope: row.defaultSessionScope as HermesSessionScope,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function requireWorkspaceMember(workspaceId: string, userId: string) {
  const [member] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  if (!member) throw new ServiceError("You are not a member of this workspace", 403);
  return member;
}

async function requireWorkspaceAdmin(workspaceId: string, userId: string) {
  const member = await requireWorkspaceMember(workspaceId, userId);
  if (!["admin", "owner"].includes(member.role)) {
    throw new ServiceError("Only workspace admins can manage Hermes bots", 403);
  }
  return member;
}

async function requireBotOwner(botId: string, userId: string) {
  const [bot] = await db
    .select({ id: bots.id, userId: bots.userId, ownerId: bots.ownerId, kind: bots.kind, name: users.name })
    .from(bots)
    .innerJoin(users, eq(bots.userId, users.id))
    .where(eq(bots.id, botId))
    .limit(1);
  if (!bot) throw new ServiceError("Bot not found", 404);
  if (bot.ownerId !== userId) throw new ServiceError("Only the bot owner can manage this Hermes bot", 403);
  if (bot.kind !== "hermes") throw new ServiceError("Bot is not a Hermes bot", 400);
  return bot;
}

async function getHermesConnection(botId: string): Promise<{ config: typeof hermesBotConfigs.$inferSelect; connection: HermesConnection }> {
  const [config] = await db.select().from(hermesBotConfigs).where(eq(hermesBotConfigs.botId, botId)).limit(1);
  if (!config) throw new ServiceError("Hermes config not found", 404);
  return { config, connection: { baseUrl: config.baseUrl, apiKey: decryptSecret(config.apiKeyEncrypted) } };
}

export async function createHermesBot(input: {
  workspaceId: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultMode?: HermesDefaultMode;
  defaultInstructions?: string | null;
  defaultSessionScope?: HermesSessionScope;
}, ownerId: string) {
  await requireWorkspaceAdmin(input.workspaceId, ownerId);
  const bot = await createBot(input.name, null, ownerId, "hermes");
  await db.insert(hermesBotConfigs).values({
    botId: bot.id,
    baseUrl: input.baseUrl.replace(/\/+$/, ""),
    apiKeyEncrypted: encryptSecret(input.apiKey),
    defaultMode: input.defaultMode ?? "run",
    defaultInstructions: input.defaultInstructions ?? null,
    defaultSessionScope: input.defaultSessionScope ?? "channel",
  });
  await addBotToWorkspace(bot.id, input.workspaceId, ownerId);
  return {
    bot: {
      id: bot.id,
      userId: bot.userId,
      name: bot.name,
      kind: "hermes" as const,
      webhookUrl: null,
      createdAt: bot.createdAt,
    },
    config: await getHermesBotConfig(bot.id, ownerId),
  };
}

export async function getHermesBotConfig(botId: string, userId: string) {
  await requireBotOwner(botId, userId);
  const { config } = await getHermesConnection(botId);
  return toPublicConfig(config);
}

export async function updateHermesBotConfig(botId: string, userId: string, updates: {
  baseUrl?: string;
  apiKey?: string;
  defaultMode?: HermesDefaultMode;
  defaultInstructions?: string | null;
  defaultSessionScope?: HermesSessionScope;
}) {
  await requireBotOwner(botId, userId);
  const set: Partial<typeof hermesBotConfigs.$inferInsert> = {};
  if (updates.baseUrl !== undefined) set.baseUrl = updates.baseUrl.replace(/\/+$/, "");
  if (updates.apiKey !== undefined) set.apiKeyEncrypted = encryptSecret(updates.apiKey);
  if (updates.defaultMode !== undefined) set.defaultMode = updates.defaultMode;
  if (updates.defaultInstructions !== undefined) set.defaultInstructions = updates.defaultInstructions;
  if (updates.defaultSessionScope !== undefined) set.defaultSessionScope = updates.defaultSessionScope;
  await db.update(hermesBotConfigs).set(set).where(eq(hermesBotConfigs.botId, botId));
  return getHermesBotConfig(botId, userId);
}

export async function testHermesBot(botId: string, userId: string) {
  await requireBotOwner(botId, userId);
  const { connection } = await getHermesConnection(botId);
  const [health, capabilities] = await Promise.all([
    getHermesHealth(connection),
    getHermesCapabilities(connection),
  ]);
  return { health, capabilities };
}

export async function getHermesBotCapabilities(botId: string, userId: string) {
  await requireBotOwner(botId, userId);
  const { connection } = await getHermesConnection(botId);
  return getHermesCapabilities(connection);
}

export function stripBotMention(content: string, botName: string) {
  const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.replace(new RegExp(`@${escaped}\\b`, "ig"), "").replace(/\s+/g, " ").trim();
}

function sessionKey(workspaceId: string | null, conversationId: string, botId: string) {
  const workspacePart = workspaceId ? `workspace:${workspaceId}` : "workspace:none";
  return `thechat:${workspacePart}:conversation:${conversationId}:bot:${botId}`;
}

function finalOutputFromEvent(event: HermesRunEvent): string | null {
  const payload = event.payload as any;
  if (!payload || typeof payload !== "object") return null;
  return payload.final_output ?? payload.finalOutput ?? payload.output ?? payload.text ?? null;
}

async function broadcastBotMessage(message: typeof messages.$inferSelect, senderName: string, conversationType: "direct" | "group") {
  const participants = await db
    .select({ userId: conversationParticipants.userId })
    .from(conversationParticipants)
    .where(eq(conversationParticipants.conversationId, message.conversationId));
  const event: WsServerEvent = {
    type: "new_message",
    message: {
      id: message.id,
      conversationId: message.conversationId,
      senderId: message.senderId,
      senderName,
      senderType: "bot",
      content: message.content,
      parts: message.parts ?? null,
      createdAt: message.createdAt.toISOString(),
    } as ChatMessage,
    conversationType,
  };
  const { broadcastToUser } = await import("../ws");
  for (const p of participants) broadcastToUser(p.userId, event);
}

export async function handleHermesMention(input: {
  botId: string;
  botUserId: string;
  botName: string;
  message: { id: string; content: string; conversationId: string; senderId: string; senderName: string };
  conversation: { id: string; type: "direct" | "group"; workspaceId: string | null };
}) {
  const { config, connection } = await getHermesConnection(input.botId);
  const prompt = stripBotMention(input.message.content, input.botName) || input.message.content;
  const key = sessionKey(input.conversation.workspaceId, input.conversation.id, input.botId);

  try {
    const hermesRun = await startHermesRun(connection, {
      input: prompt,
      session_id: key,
      instructions: config.defaultInstructions,
    });
    const hermesRunId = String(hermesRun.run_id ?? hermesRun.id);

    let finalOutput = "";
    await streamHermesRunEvents(connection, hermesRunId, async (event) => {
      const maybeFinal = finalOutputFromEvent(event);
      if (maybeFinal) finalOutput = String(maybeFinal);
    });

    if (!finalOutput) finalOutput = "Hermes run completed without a final message.";
    const [responseMessage] = await db
      .insert(messages)
      .values({
        conversationId: input.conversation.id,
        senderId: input.botUserId,
        content: finalOutput,
        parts: [{ type: "text", text: finalOutput }],
      })
      .returning();
    await broadcastBotMessage(responseMessage, input.botName, input.conversation.type);
  } catch (error: any) {
    const content = `Hermes run failed: ${error?.message ?? String(error)}`;
    const [responseMessage] = await db
      .insert(messages)
      .values({ conversationId: input.conversation.id, senderId: input.botUserId, content })
      .returning();
    await broadcastBotMessage(responseMessage, input.botName, input.conversation.type);
  }
}
