import { eq } from "drizzle-orm";
import { db } from "../db";
import { bots, hermesBotConfigs, users } from "../db/schema";
import { ServiceError } from "./errors";

export type HermesDefaultMode = "run" | "response";

function toPublicConfig(row: typeof hermesBotConfigs.$inferSelect) {
  return {
    botId: row.botId,
    defaultMode: row.defaultMode as HermesDefaultMode,
    defaultInstructions: row.defaultInstructions,
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
  defaultInstructions?: string | null;
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
      defaultInstructions: defaults.defaultInstructions ?? null,
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
  defaultInstructions?: string | null;
}) {
  await requireBotOwner(botId, userId);
  await ensureHermesBotConfig(botId);

  const set: Partial<typeof hermesBotConfigs.$inferInsert> = {};
  if (updates.defaultMode !== undefined) set.defaultMode = updates.defaultMode;
  if (updates.defaultInstructions !== undefined) set.defaultInstructions = updates.defaultInstructions;
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
