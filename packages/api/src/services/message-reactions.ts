import type { MessageReactionSummary } from "@thechat/shared";
import { and, asc, count, countDistinct, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  conversationParticipants,
  messageReactions,
  messages,
  users,
} from "../db/schema";
import { log } from "../logging";
import { publishWsEventToUsers } from "../realtime";
import { requireConversationMutationAccess } from "./conversation-mutation-access";
import { ServiceError } from "./errors";

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ReactionReadExecutor = typeof db | DbTransaction;

const reactionLog = log.child({ component: "message-reactions" });
const MAX_REACTIONS_PER_USER_PER_MESSAGE = 20;
const MAX_REACTION_EMOJIS_PER_MESSAGE = 20;
const REACTION_EMOJI_COMPONENT = String.raw`(?:\p{Emoji_Modifier_Base}\uFE0F?\p{Emoji_Modifier}|\p{Extended_Pictographic}\uFE0F?)`;
const REACTION_EMOJI_SEQUENCE = new RegExp(
  String.raw`^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|${REACTION_EMOJI_COMPONENT}(?:\u200D${REACTION_EMOJI_COMPONENT})*|\u{1F3F4}[\u{E0061}-\u{E007A}]+\u{E007F})$`,
  "u",
);

export async function messageReactionsByMessageIds(
  messageIds: string[],
  viewerId: string,
  executor: ReactionReadExecutor = db,
): Promise<Map<string, MessageReactionSummary[]>> {
  if (messageIds.length === 0) return new Map();

  const rows = await executor
    .select({
      messageId: messageReactions.messageId,
      emoji: messageReactions.emoji,
      userId: messageReactions.userId,
      userName: users.name,
    })
    .from(messageReactions)
    .innerJoin(users, eq(users.id, messageReactions.userId))
    .where(inArray(messageReactions.messageId, messageIds))
    .orderBy(
      asc(messageReactions.createdAt),
      asc(users.name),
      asc(messageReactions.userId),
    );

  const grouped = new Map<string, Map<string, MessageReactionSummary>>();
  for (const row of rows) {
    let messageGroups = grouped.get(row.messageId);
    if (!messageGroups) {
      messageGroups = new Map();
      grouped.set(row.messageId, messageGroups);
    }
    let reaction = messageGroups.get(row.emoji);
    if (!reaction) {
      reaction = {
        emoji: row.emoji,
        count: 0,
        reactedByMe: false,
        userNames: [],
      };
      messageGroups.set(row.emoji, reaction);
    }
    reaction.count += 1;
    reaction.reactedByMe ||= row.userId === viewerId;
    reaction.userNames.push(row.userName);
  }

  return new Map(
    [...grouped].map(([messageId, reactions]) => [
      messageId,
      [...reactions.values()],
    ]),
  );
}

export async function setMessageReaction(
  conversationId: string,
  messageId: string,
  userId: string,
  emoji: string,
  active: boolean,
) {
  const normalizedEmoji = normalizeReactionEmoji(emoji);

  const result = await db.transaction(async (tx) => {
    await requireConversationMutationAccess(tx, conversationId, userId);

    const [lockedMessage] = await tx
      .select({ conversationId: messages.conversationId })
      .from(messages)
      .where(
        and(
          eq(messages.id, messageId),
          eq(messages.conversationId, conversationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!lockedMessage) throw new ServiceError("Message not found", 404);

    if (active) {
      const [existingReaction] = await tx
        .select({ messageId: messageReactions.messageId })
        .from(messageReactions)
        .where(
          and(
            eq(messageReactions.messageId, messageId),
            eq(messageReactions.userId, userId),
            eq(messageReactions.emoji, normalizedEmoji),
          ),
        )
        .limit(1);

      if (!existingReaction) {
        const [perUserCount] = await tx
          .select({ value: count() })
          .from(messageReactions)
          .where(
            and(
              eq(messageReactions.messageId, messageId),
              eq(messageReactions.userId, userId),
            ),
          );
        if (
          (perUserCount?.value ?? 0) >= MAX_REACTIONS_PER_USER_PER_MESSAGE
        ) {
          throw new ServiceError(
            `A user can add at most ${MAX_REACTIONS_PER_USER_PER_MESSAGE} reactions per message`,
            400,
          );
        }

        const [existingEmoji] = await tx
          .select({ messageId: messageReactions.messageId })
          .from(messageReactions)
          .where(
            and(
              eq(messageReactions.messageId, messageId),
              eq(messageReactions.emoji, normalizedEmoji),
            ),
          )
          .limit(1);
        if (!existingEmoji) {
          const [perMessageCount] = await tx
            .select({ value: countDistinct(messageReactions.emoji) })
            .from(messageReactions)
            .where(eq(messageReactions.messageId, messageId));
          if (
            (perMessageCount?.value ?? 0) >= MAX_REACTION_EMOJIS_PER_MESSAGE
          ) {
            throw new ServiceError(
              `A message can have at most ${MAX_REACTION_EMOJIS_PER_MESSAGE} reaction emojis`,
              400,
            );
          }
        }

        await tx
          .insert(messageReactions)
          .values({ messageId, userId, emoji: normalizedEmoji })
          .onConflictDoNothing();
      }
    } else {
      await tx
        .delete(messageReactions)
        .where(
          and(
            eq(messageReactions.messageId, messageId),
            eq(messageReactions.userId, userId),
            eq(messageReactions.emoji, normalizedEmoji),
          ),
        );
    }

    const reactionMap = await messageReactionsByMessageIds(
      [messageId],
      userId,
      tx,
    );
    return {
      messageId,
      conversationId: lockedMessage.conversationId,
      reactions: reactionMap.get(messageId) ?? [],
    };
  });

  try {
    const recipients = await db
      .select({ userId: conversationParticipants.userId })
      .from(conversationParticipants)
      .where(eq(conversationParticipants.conversationId, conversationId));
    await publishWsEventToUsers(
      recipients.map(({ userId: recipientId }) => recipientId),
      {
        type: "message_reactions_updated",
        conversationId,
        messageId,
      },
    );
  } catch (error) {
    reactionLog.warn(
      { err: error, conversationId, messageId },
      "Failed to publish reaction update",
    );
  }

  return result;
}

function normalizeReactionEmoji(value: string) {
  const normalized = value
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim();
  const graphemes = [
    ...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(normalized),
  ];
  if (
    !normalized ||
    normalized.length > 32 ||
    /\s/u.test(normalized) ||
    graphemes.length !== 1 ||
    !REACTION_EMOJI_SEQUENCE.test(normalized)
  ) {
    throw new ServiceError("Reaction must be a single emoji", 400);
  }
  return normalized;
}
