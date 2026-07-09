import { and, eq } from "drizzle-orm";
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
  senderId: string;
  senderType: "bot" | "human";
}

type QueryExecutor = Pick<typeof db, "select">;

/**
 * Resolve the bot IDs that are eligible for a message while the message and its
 * outbox event are still in the same transaction. Persisting these IDs in the
 * event makes retries and Kafka replays independent of later bot renames or
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

  return participantBots
    .filter((bot) => {
      if (bot.botUserId === input.senderId) return false;
      if (bot.kind === "webhook" && !bot.webhookUrl) return false;

      const escaped = bot.botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const isMentioned = new RegExp(`@${escaped}\\b`, "i").test(
        input.content,
      );
      const isDirectHermesDm =
        input.senderType !== "bot" &&
        conversation.type === "direct" &&
        bot.kind === "hermes";
      return isMentioned || isDirectHermesDm;
    })
    .map((bot) => bot.botId)
    .sort();
}
