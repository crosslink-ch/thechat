import { and, eq } from "drizzle-orm";
import type { MessageContentFormat } from "@thechat/shared";
import { db } from "../db";
import {
  bots,
  conversationParticipants,
  conversations,
  users,
} from "../db/schema";

interface MessageBotTargetInput {
  conversationId: string;
  content: string;
  /**
   * "parts-v1": only the referenced user IDs count. A typed or pasted "@Koda"
   * that was not picked from the menu is plain text. Otherwise the legacy
   * name match on `content` applies.
   */
  contentFormat?: MessageContentFormat;
  referencedUserIds?: readonly string[];
  senderId: string;
  senderType: "bot" | "human";
}

type QueryExecutor = Pick<typeof db, "select">;

/**
 * Resolve the bot IDs that are eligible for a message while the message and its
 * outbox event are still in the same transaction. Persisting these IDs in the
 * event makes retries independent of later bot renames or
 * additions while still allowing processing-time membership revocation.
 */
export async function resolveMessageBotTargetIds(
  executor: QueryExecutor,
  input: MessageBotTargetInput,
): Promise<string[]> {
  const [conversation] = await executor
    .select({ type: conversations.type })
    .from(conversations)
    .where(eq(conversations.id, input.conversationId))
    .limit(1);
  if (!conversation) return [];

  const participantBots = await executor
    .select({
      botId: bots.id,
      botUserId: bots.userId,
      kind: bots.kind,
      webhookUrl: bots.webhookUrl,
      botName: users.name,
    })
    .from(conversationParticipants)
    .innerJoin(
      bots,
      eq(conversationParticipants.userId, bots.userId),
    )
    .innerJoin(users, eq(bots.userId, users.id))
    .where(
      and(
        eq(conversationParticipants.conversationId, input.conversationId),
        eq(users.type, "bot"),
      ),
    );

  const referenced =
    input.contentFormat === "parts-v1" ? new Set(input.referencedUserIds ?? []) : null;
  return participantBots
    .filter((bot) => {
      if (bot.botUserId === input.senderId) return false;
      if (bot.kind === "webhook" && !bot.webhookUrl) return false;

      const isMentioned = referenced
        ? referenced.has(bot.botUserId)
        : legacyMentionsBot(input.content, bot.botName);
      const isDirectHermesDm =
        input.senderType !== "bot" &&
        conversation.type === "direct" &&
        bot.kind === "hermes";
      return isMentioned || isDirectHermesDm;
    })
    .map((bot) => bot.botId)
    .sort();
}

/** Legacy text routing for content-only requests (API, MCP, older clients). */
function legacyMentionsBot(content: string, botName: string) {
  const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@${escaped}\\b`, "i").test(content);
}
