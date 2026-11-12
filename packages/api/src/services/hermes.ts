import { eq } from "drizzle-orm";
import { referenceText, type StoredChatPart } from "@thechat/shared";
import { db } from "../db";
import { bots, hermesBotConfigs, users } from "../db/schema";
import { ServiceError } from "./errors";

export type HermesDefaultMode = "run" | "response";

function toPublicConfig(row: typeof hermesBotConfigs.$inferSelect) {
  return {
    botId: row.botId,
    defaultMode: row.defaultMode as HermesDefaultMode,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function requireBotOwner(botId: string, userId: string) {
  const [bot] = await db
    .select({ id: bots.id, ownerId: bots.ownerId, kind: bots.kind, name: users.name })
    .from(bots)
    .innerJoin(users, eq(bots.userId, users.id))
    .where(eq(bots.id, botId))
    .limit(1);
  if (!bot) throw new ServiceError("Bot not found", 404);
  if (bot.ownerId !== userId) throw new ServiceError("Only the bot owner can manage this Hermes bot", 403);
  if (bot.kind !== "hermes") throw new ServiceError("Bot is not a Hermes bot", 400);
  return bot;
}

export async function ensureHermesBotConfig(botId: string, defaults: {
  defaultMode?: HermesDefaultMode;
} = {}) {
  const [existing] = await db
    .select()
    .from(hermesBotConfigs)
    .where(eq(hermesBotConfigs.botId, botId))
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(hermesBotConfigs)
    .values({
      botId,
      baseUrl: null,
      apiKeyEncrypted: null,
      defaultMode: defaults.defaultMode ?? "run",
    })
    .returning();
  return created;
}

export async function getHermesBotConfig(botId: string, userId: string) {
  await requireBotOwner(botId, userId);
  return toPublicConfig(await ensureHermesBotConfig(botId));
}

export async function updateHermesBotConfig(botId: string, userId: string, updates: {
  defaultMode?: HermesDefaultMode;
}) {
  await requireBotOwner(botId, userId);
  await ensureHermesBotConfig(botId);

  const set: Partial<typeof hermesBotConfigs.$inferInsert> = {};
  if (updates.defaultMode !== undefined) set.defaultMode = updates.defaultMode;
  if (Object.keys(set).length > 0) {
    await db.update(hermesBotConfigs).set(set).where(eq(hermesBotConfigs.botId, botId));
  }
  const [config] = await db.select().from(hermesBotConfigs).where(eq(hermesBotConfigs.botId, botId)).limit(1);
  if (!config) throw new ServiceError("Hermes config not found", 404);
  return toPublicConfig(config);
}

export async function testHermesBot(botId: string, userId: string) {
  await requireBotOwner(botId, userId);
  await ensureHermesBotConfig(botId);
  return {
    ok: true,
    platform: "thechat",
    adapter: "Hermes Gateway must run with THECHAT_BASE_URL and this bot's THECHAT_BOT_TOKEN",
    tokenScope: "bot",
  };
}

export async function getHermesBotCapabilities(botId: string, userId: string) {
  await requireBotOwner(botId, userId);
  await ensureHermesBotConfig(botId);
  return {
    platform: "thechat",
    directMessages: true,
    workspaceBots: true,
    multipleBotsPerWorkspace: true,
    continuousConversation: true,
    runtimeEvents: true,
  };
}

export function stripBotMention(content: string, botName: string) {
  const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.replace(new RegExp(`@${escaped}\\b`, "ig"), "").replace(/\s+/g, " ").trim();
}

/**
 * The prompt Hermes receives for a "parts-v1" message: the parts with every
 * reference to the invoked bot removed, other references kept as "@Name".
 * Unlike the legacy name strip, line breaks and indentation are kept; only
 * the space the removed mention leaves behind is tidied.
 */
export function hermesPromptFromParts(
  parts: readonly StoredChatPart[],
  botUserId: string,
): string {
  const segments: string[] = [];
  let removedBefore = false;
  for (const part of parts) {
    const removed = part.type === "reference" && part.refId === botUserId;
    if (removed) {
      removedBefore = true;
      continue;
    }
    let text = part.type === "text" ? part.text : referenceText(part.label);
    if (removedBefore) {
      const previous = segments.length > 0 ? segments[segments.length - 1]! : "";
      if (previous === "" || previous.endsWith("\n")) {
        // The mention started the line: drop the space after it.
        text = text.replace(/^[ \t]+/, "");
      } else if (/[ \t]$/.test(previous) && /^[ \t]/.test(text)) {
        // "Hi @Koda please": keep one space between the neighbours.
        text = text.slice(1);
      } else if (/^\n/.test(text) || text === "") {
        segments[segments.length - 1] = previous.replace(/[ \t]+$/, "");
      }
      removedBefore = false;
    }
    segments.push(text);
  }
  if (removedBefore && segments.length > 0) {
    // The mention ended the message: drop the space before it.
    segments[segments.length - 1] = segments[segments.length - 1]!.replace(/[ \t]+$/, "");
  }
  // Blank lines left at the start by a mention on its own line go too.
  return segments.join("").replace(/^(?:[ \t]*\n)+/, "").trimEnd();
}
