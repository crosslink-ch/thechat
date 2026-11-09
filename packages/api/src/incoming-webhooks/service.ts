import crypto from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import {
  conversations,
  conversationParticipants,
  incomingWebhooks,
  messages,
  users,
  workspaceMembers,
  workspaces,
} from "../db/schema";
import { ServiceError } from "../services/errors";
import { recordMessageUnreads } from "../services/activity";
import { toChatMessage } from "../services/messages";
import { createChatMessageSentV1 } from "../events/envelope";
import { enqueueDomainEvent } from "../events/outbox";
import { publishWsEventToUsers } from "../realtime";
import { log } from "../logging";
import { incomingWebhookConfig } from "./config";

export class WebhookRateLimitError extends ServiceError {
  constructor(readonly retryAfter: number) {
    super("Rate limit exceeded; retry after the indicated delay", 429);
  }
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const hookLog = log.child({ component: "incoming-webhooks" });
const publicColumns = {
  id: incomingWebhooks.id,
  name: users.name,
  tokenStart: incomingWebhooks.tokenStart,
  createdAt: incomingWebhooks.createdAt,
  lastUsedAt: incomingWebhooks.lastUsedAt,
};
function metadata(row: {
  id: string;
  name: string;
  tokenStart: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}) {
  return {
    id: row.id,
    name: row.name,
    tokenStart: row.tokenStart,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

// Same lock ordering as channel/message mutations: workspace first, child next.
// Role changes and channel deletion hold the workspace FOR UPDATE.
async function lockChannel(tx: Transaction, conversationId: string) {
  const [candidate] = await tx
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  if (candidate?.type !== "group" || !candidate.workspaceId)
    throw new ServiceError("Channel not found", 404);
  const [workspace] = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, candidate.workspaceId))
    .for("key share");
  if (!workspace) throw new ServiceError("Channel not found", 404);
  const [channel] = await tx
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.workspaceId, workspace.id),
        eq(conversations.type, "group"),
      ),
    )
    .for("key share");
  if (!channel) throw new ServiceError("Channel not found", 404);
  return { ...channel, workspaceId: workspace.id };
}
async function requireManager(
  tx: Transaction,
  conversationId: string,
  userId: string,
) {
  const channel = await lockChannel(tx, conversationId);
  const [member] = await tx
    .select({ role: workspaceMembers.role, type: users.type })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .innerJoin(
      conversationParticipants,
      and(
        eq(conversationParticipants.userId, users.id),
        eq(conversationParticipants.conversationId, channel.id),
      ),
    )
    .where(
      and(
        eq(workspaceMembers.workspaceId, channel.workspaceId),
        eq(workspaceMembers.userId, userId),
      ),
    );
  if (
    member?.type !== "human" ||
    (member.role !== "owner" && member.role !== "admin")
  ) {
    throw new ServiceError(
      "Only workspace owners and admins can manage incoming webhooks",
      403,
    );
  }
  return channel;
}

export async function createIncomingWebhook(
  conversationId: string,
  userId: string,
  name: string,
) {
  const token = `tchat_wh_${crypto.randomBytes(32).toString("hex")}`;
  return db.transaction(async (tx) => {
    await requireManager(tx, conversationId, userId);
    const [sender] = await tx
      .insert(users)
      .values({ name, type: "bot" })
      .returning();
    const [row] = await tx
      .insert(incomingWebhooks)
      .values({
        conversationId,
        userId: sender.id,
        createdById: userId,
        tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
        tokenStart: token.slice(0, 17),
      })
      .returning();
    return {
      webhook: metadata({ ...row, name: sender.name }),
      path: `/hooks/incoming/${token}`,
    };
  });
}
export async function listIncomingWebhooks(
  conversationId: string,
  userId: string,
) {
  return db.transaction(async (tx) => {
    await requireManager(tx, conversationId, userId);
    const rows = await tx
      .select(publicColumns)
      .from(incomingWebhooks)
      .innerJoin(users, eq(users.id, incomingWebhooks.userId))
      .where(
        and(
          eq(incomingWebhooks.conversationId, conversationId),
          isNull(incomingWebhooks.revokedAt),
        ),
      )
      .orderBy(desc(incomingWebhooks.createdAt), desc(incomingWebhooks.id));
    return { webhooks: rows.map(metadata) };
  });
}
export async function revokeIncomingWebhook(
  conversationId: string,
  userId: string,
  webhookId: string,
) {
  return db.transaction(async (tx) => {
    await requireManager(tx, conversationId, userId);
    const [row] = await tx
      .update(incomingWebhooks)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(incomingWebhooks.id, webhookId),
          eq(incomingWebhooks.conversationId, conversationId),
          isNull(incomingWebhooks.revokedAt),
        ),
      )
      .returning({ id: incomingWebhooks.id });
    if (!row) throw new ServiceError("Webhook not found", 404);
    return { ok: true as const };
  });
}

export async function postIncomingWebhook(token: string, content: string) {
  if (!/^tchat_wh_[0-9a-f]{64}$/.test(token))
    throw new ServiceError("Webhook not found", 404);
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const [candidate] = await db
    .select({
      id: incomingWebhooks.id,
      conversationId: incomingWebhooks.conversationId,
    })
    .from(incomingWebhooks)
    .where(
      and(
        eq(incomingWebhooks.tokenHash, hash),
        isNull(incomingWebhooks.revokedAt),
      ),
    );
  if (!candidate) throw new ServiceError("Webhook not found", 404);
  const result = await db.transaction(async (tx) => {
    const channel = await lockChannel(tx, candidate.conversationId);
    // Revocation and acceptance serialize on this row. No posts can commit
    // after a completed revocation, including ones waiting for a lock.
    const [hook] = await tx
      .select()
      .from(incomingWebhooks)
      .where(
        and(
          eq(incomingWebhooks.id, candidate.id),
          eq(incomingWebhooks.tokenHash, hash),
          isNull(incomingWebhooks.revokedAt),
        ),
      )
      .for("update");
    if (!hook) throw new ServiceError("Webhook not found", 404);
    // Use the DB clock for consistent budgets across replicas; read it AFTER
    // obtaining the lock (transaction start time may predate a long wait).
    const [clock] = await tx.execute<{ now: string }>(
      sql`select clock_timestamp()::text as now`,
    );
    const now = new Date(clock.now);
    const windowMs = incomingWebhookConfig.rateLimitWindowMs;
    const currentWindow =
      hook.windowStartedAt &&
      now.getTime() - hook.windowStartedAt.getTime() < windowMs;
    const count = currentWindow ? hook.windowCount : 0;
    if (count >= incomingWebhookConfig.rateLimitMax) {
      throw new WebhookRateLimitError(
        Math.max(
          1,
          Math.ceil(
            (hook.windowStartedAt!.getTime() + windowMs - now.getTime()) / 1000,
          ),
        ),
      );
    }
    const [sender] = await tx
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, hook.userId));
    const [message] = await tx
      .insert(messages)
      .values({
        conversationId: channel.id,
        senderId: hook.userId,
        content,
      })
      .returning();
    await recordMessageUnreads(tx, message);
    await enqueueDomainEvent(
      tx,
      createChatMessageSentV1({
        messageId: message.id,
        conversationId: channel.id,
        senderId: hook.userId,
        senderType: "bot",
        workspaceId: channel.workspaceId,
        occurredAt: message.createdAt,
        messageKind: "bot_response",
        automationDepth: 1,
        targetBotIds: [],
      }),
      { partitionKey: channel.id },
    );
    await tx
      .update(incomingWebhooks)
      .set({
        lastUsedAt: message.createdAt,
        windowStartedAt: currentWindow ? hook.windowStartedAt : now,
        windowCount: count + 1,
      })
      .where(eq(incomingWebhooks.id, hook.id));
    const recipients = await tx
      .select({ id: conversationParticipants.userId })
      .from(conversationParticipants)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.userId, conversationParticipants.userId),
          eq(workspaceMembers.workspaceId, channel.workspaceId),
        ),
      )
      .where(eq(conversationParticipants.conversationId, channel.id));
    return {
      message: toChatMessage(
        { ...message, senderName: sender.name, senderType: "bot" },
        [],
        [],
      ),
      recipients: recipients.map((r) => r.id),
    };
  });
  try {
    await publishWsEventToUsers(result.recipients, {
      type: "new_message",
      message: result.message,
      conversationType: "group",
    });
  } catch {
    // Persistence succeeded; do not invite a retry that duplicates the message.
    hookLog.warn(
      { webhookId: candidate.id, messageId: result.message.id },
      "incoming_webhook.realtime_publish_failed",
    );
  }
}
