import { and, count, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type {
  NotificationPreferences,
  PushNotificationKind,
  PushNotificationPayload,
} from "@thechat/shared";
import { db } from "../db";
import {
  botInvocations,
  botRequests,
  bots,
  conversationParticipants,
  conversationThreads,
  conversations,
  messageThreadFollowers,
  messageUnreads,
  messages,
  users,
  workspaceMembers,
} from "../db/schema";
import { getNotificationPreferences } from "./preferences";
import { messageMentionsUser } from "../services/message-threads";

/** What a queued notification refers to. Content is rebuilt at send time. */
export type PushSource =
  /**
   * invocationId: the agent run a bot message answers, when known.
   * waitRound: how many times fan-out has waited for that run to finish.
   */
  | { type: "message"; messageId: string; invocationId?: string; waitRound?: number }
  | { type: "bot_request"; requestId: string }
  | { type: "test"; nonce: string };

export interface PlannedRecipient {
  userId: string;
  kind: PushNotificationKind;
}

const PREVIEW_MAX_CHARS = 180;
const TITLE_MAX_CHARS = 80;

export function kindAllowed(
  preferences: NotificationPreferences,
  kind: PushNotificationKind,
) {
  switch (kind) {
    case "direct_message":
      return preferences.directMessages;
    case "mention":
      return preferences.mentions;
    case "thread_reply":
      return preferences.threadReplies ?? true;
    case "agent_reply":
      return preferences.agentReplies;
    case "agent_progress":
      // Progress refines agent replies: only for people who want both.
      return preferences.agentReplies && preferences.agentProgress;
    case "agent_request":
      return preferences.agentRequests;
    case "test":
      return true;
  }
}

export { mentionsName } from "../services/message-threads";

export function previewText(content: string, maxChars = PREVIEW_MAX_CHARS) {
  const normalized = content.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

function clampTitle(value: string) {
  return previewText(value, TITLE_MAX_CHARS);
}

export function openConversationUrl(input: {
  conversationId: string;
  conversationType: "direct" | "group";
  workspaceId: string | null;
  threadId: string | null;
  /** Open this reply thread in the side panel. */
  replyRootId?: string | null;
}) {
  const params = new URLSearchParams({
    conversationId: input.conversationId,
    type: input.conversationType,
  });
  if (input.workspaceId) params.set("workspaceId", input.workspaceId);
  if (input.threadId) params.set("threadId", input.threadId);
  if (input.replyRootId) params.set("replyThread", input.replyRootId);
  return `#/open?${params.toString()}`;
}

function conversationTag(
  conversationId: string,
  threadId: string | null,
  replyRootId: string | null = null,
) {
  return replyRootId
    ? `conversation:${conversationId}:reply:${replyRootId}`
    : `conversation:${conversationId}:${threadId ?? "main"}`;
}

// -- Shared access rule ---------------------------------------------------

/** A human participant who is still a member of the conversation's workspace. */
function activeHumanParticipant(
  conversationId: string,
  workspaceId: string | null,
) {
  return and(
    eq(conversationParticipants.conversationId, conversationId),
    eq(users.type, "human"),
    workspaceId
      ? sql`EXISTS (
          SELECT 1 FROM ${workspaceMembers} wm
          WHERE wm.workspace_id = ${workspaceId}
            AND wm.user_id = ${conversationParticipants.userId}
        )`
      : sql`true`,
  );
}

async function activeHumanParticipants(
  conversationId: string,
  workspaceId: string | null,
  options: { excludeUserId?: string; onlyUserIds?: string[] } = {},
) {
  if (options.onlyUserIds && options.onlyUserIds.length === 0) return [];
  return db
    .select({ userId: users.id, name: users.name })
    .from(conversationParticipants)
    .innerJoin(users, eq(users.id, conversationParticipants.userId))
    .where(
      and(
        activeHumanParticipant(conversationId, workspaceId),
        options.excludeUserId
          ? ne(conversationParticipants.userId, options.excludeUserId)
          : undefined,
        options.onlyUserIds
          ? inArray(conversationParticipants.userId, options.onlyUserIds)
          : undefined,
      ),
    );
}

async function unreadBadge(userId: string) {
  const [row] = await db
    .select({ value: count() })
    .from(messageUnreads)
    .where(eq(messageUnreads.userId, userId));
  return Number(row?.value ?? 0);
}

// -- Messages -----------------------------------------------------------------

async function loadMessageContext(messageId: string) {
  const [row] = await db
    .select({
      id: messages.id,
      content: messages.content,
      contentFormat: messages.contentFormat,
      parts: messages.parts,
      interim: messages.interim,
      conversationId: messages.conversationId,
      threadId: messages.threadId,
      parentMessageId: messages.parentMessageId,
      alsoSentToConversation: messages.alsoSentToConversation,
      senderId: messages.senderId,
      createdAt: messages.createdAt,
      senderName: users.name,
      senderType: users.type,
      conversationType: conversations.type,
      workspaceId: conversations.workspaceId,
      conversationName: conversations.name,
      conversationTitle: conversations.title,
      threadTitle: conversationThreads.title,
    })
    .from(messages)
    .innerJoin(users, eq(users.id, messages.senderId))
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .leftJoin(conversationThreads, eq(conversationThreads.id, messages.threadId))
    .where(eq(messages.id, messageId))
    .limit(1);
  return row ?? null;
}

type MessageContext = NonNullable<Awaited<ReturnType<typeof loadMessageContext>>>;

/**
 * A newer message from the same sender in the same place supersedes this one.
 * A progress update never supersedes an answer: "⏳ Working" posted after a
 * reply must not swallow the reply's notification.
 */
async function hasNewerMessageFromSender(
  context: Pick<
    MessageContext,
    "id" | "conversationId" | "threadId" | "parentMessageId" | "senderId" | "createdAt" | "interim"
  >,
) {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, context.conversationId),
        eq(messages.senderId, context.senderId),
        context.threadId ? eq(messages.threadId, context.threadId) : isNull(messages.threadId),
        context.parentMessageId
          ? eq(messages.parentMessageId, context.parentMessageId)
          : isNull(messages.parentMessageId),
        ne(messages.id, context.id),
        context.interim ? undefined : eq(messages.interim, false),
        or(
          gt(messages.createdAt, context.createdAt),
          and(eq(messages.createdAt, context.createdAt), gt(messages.id, context.id)),
        ),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** An agent's progress update, flagged by the gateway that posted it. */
export async function isInterimMessage(messageId: string) {
  const [row] = await db
    .select({ interim: messages.interim })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  return row?.interim === true;
}

/**
 * True while a Hermes run is still going. Its unflagged messages then may be interim
 * ("Looking into it…"); only the newest one after the run ends should notify.
 * A run ends when it records a completion: a final message (`complete: true`),
 * the gateway's `/completed` call, a failure or a cancellation. `completed_at`
 * is not the signal: it is set as soon as Hermes claims the invocation.
 */
export async function agentRunInProgress(invocationId: string) {
  const [row] = await db
    .select({
      adapterKind: botInvocations.adapterKind,
      status: botInvocations.status,
      responseJson: botInvocations.responseJson,
    })
    .from(botInvocations)
    .where(eq(botInvocations.id, invocationId))
    .limit(1);
  if (!row || row.adapterKind !== "hermes") return false;
  if (["completed", "failed", "cancelled"].includes(row.status)) return false;
  const response = row.responseJson ?? {};
  const completion = response.completion;
  const completed =
    (typeof completion === "object" && completion !== null && !Array.isArray(completion) &&
      typeof (completion as Record<string, unknown>).type === "string") ||
    response.silent === true;
  return !completed;
}

/** The person whose message started the agent run this bot message belongs to. */
async function invocationRequesterId(
  context: Pick<MessageContext, "conversationId" | "senderType">,
  invocationId: string | undefined,
) {
  if (context.senderType !== "bot" || !invocationId) return null;
  const [row] = await db
    .select({ senderId: messages.senderId })
    .from(botInvocations)
    .innerJoin(messages, eq(messages.id, botInvocations.triggerMessageId))
    .where(
      and(
        eq(botInvocations.id, invocationId),
        eq(botInvocations.conversationId, context.conversationId),
      ),
    )
    .limit(1);
  return row?.senderId ?? null;
}

/** The part of a message that decides who it mentions. */
type MentionSource = Pick<MessageContext, "content"> & {
  contentFormat?: string | null;
  parts?: unknown;
};

export function classifyMessage(
  context: Pick<MessageContext, "conversationType" | "senderType"> & MentionSource & {
    interim?: boolean;
    /** Set for a reply in a reply thread. */
    parentMessageId?: string | null;
  },
  recipient: { userId: string; name: string; followsThread?: boolean },
  requesterId: string | null = null,
): PushNotificationKind | null {
  const kind = baseMessageKind(context, recipient, requesterId);
  // Whoever would hear about the agent's answer may opt into its progress too.
  return kind && context.senderType === "bot" && context.interim ? "agent_progress" : kind;
}

function baseMessageKind(
  context: Pick<MessageContext, "conversationType" | "senderType"> & MentionSource & {
    parentMessageId?: string | null;
  },
  recipient: { userId: string; name: string; followsThread?: boolean },
  requesterId: string | null,
): PushNotificationKind | null {
  if (context.conversationType === "direct") {
    return context.senderType === "bot" ? "agent_reply" : "direct_message";
  }
  // An agent answering you in a channel is a reply, even without an @mention.
  if (context.senderType === "bot" && requesterId === recipient.userId) {
    return "agent_reply";
  }
  if (messageMentionsUser(context, recipient)) return "mention";
  // A reply in a thread you follow (you started it, replied or were mentioned).
  return context.parentMessageId && recipient.followsThread ? "thread_reply" : null;
}

/** Who follows a reply thread (and so hears about its replies). */
async function threadFollowerIds(rootMessageId: string | null) {
  if (!rootMessageId) return new Set<string>();
  const rows = await db
    .select({ userId: messageThreadFollowers.userId })
    .from(messageThreadFollowers)
    .where(
      and(
        eq(messageThreadFollowers.rootMessageId, rootMessageId),
        eq(messageThreadFollowers.following, true),
      ),
    );
  return new Set(rows.map((row) => row.userId));
}

/** Who should hear about this message: DMs, agent replies and @mentions. */
export async function planMessageRecipients(
  messageId: string,
  invocationId?: string,
): Promise<PlannedRecipient[]> {
  const context = await loadMessageContext(messageId);
  if (!context) return [];
  const participants = await activeHumanParticipants(
    context.conversationId,
    context.workspaceId,
    { excludeUserId: context.senderId },
  );
  const requesterId = await invocationRequesterId(context, invocationId);
  const followers = await threadFollowerIds(context.parentMessageId);
  const planned: PlannedRecipient[] = [];
  for (const participant of participants) {
    const kind = classifyMessage(
      context,
      { ...participant, followsThread: followers.has(participant.userId) },
      requesterId,
    );
    if (!kind) continue;
    const preferences = await getNotificationPreferences(participant.userId);
    if (kindAllowed(preferences, kind)) planned.push({ userId: participant.userId, kind });
  }
  return planned;
}

async function buildMessagePayload(
  messageId: string,
  invocationId: string | undefined,
  userId: string,
): Promise<PushNotificationPayload | null> {
  const context = await loadMessageContext(messageId);
  if (!context || context.senderId === userId) return null;
  const [recipient] = await activeHumanParticipants(
    context.conversationId,
    context.workspaceId,
    { onlyUserIds: [userId] },
  );
  if (!recipient) return null;
  // Read on any device during the delay: nothing to tell the phone. Progress
  // updates leave no unread rows, so for them only a newer message counts.
  if (!context.interim) {
    const [unread] = await db
      .select({ messageId: messageUnreads.messageId })
      .from(messageUnreads)
      .where(and(eq(messageUnreads.messageId, messageId), eq(messageUnreads.userId, userId)))
      .limit(1);
    if (!unread) return null;
  }
  // Agents can post several messages in one turn. Only the newest one notifies.
  if (context.senderType === "bot" && (await hasNewerMessageFromSender(context))) return null;

  const followers = await threadFollowerIds(context.parentMessageId);
  const kind = classifyMessage(
    context,
    { ...recipient, followsThread: followers.has(userId) },
    await invocationRequesterId(context, invocationId),
  );
  if (!kind) return null;
  const preferences = await getNotificationPreferences(userId);
  if (!kindAllowed(preferences, kind)) return null;

  const channel = context.conversationName ?? context.conversationTitle ?? "channel";
  const inReplyThread = Boolean(context.parentMessageId);
  const title =
    context.conversationType === "group"
      ? inReplyThread
        ? `${context.senderName} in a thread in #${channel}`
        : `${context.senderName} in #${channel}`
      : (kind === "agent_reply" || kind === "agent_progress") && context.threadTitle
        ? `${context.senderName} · ${context.threadTitle}`
        : inReplyThread
          ? `${context.senderName} in a thread`
          : context.senderName;
  const preview = previewText(context.content) || "Sent an attachment";
  const hidden =
    kind === "mention"
      ? "Mentioned you"
      : kind === "agent_reply" || kind === "thread_reply"
        ? "Replied"
        : kind === "agent_progress"
          ? "Still working"
          : "Sent you a message";
  return {
    v: 1,
    id: `message:${context.id}`,
    kind,
    title: clampTitle(title),
    body: preferences.showPreviews ? preview : hidden,
    tag: conversationTag(context.conversationId, context.threadId, context.parentMessageId),
    url: openConversationUrl({ ...context, replyRootId: context.parentMessageId }),
    timestamp: context.createdAt.getTime(),
    badge: await unreadBadge(userId),
  };
}

// -- Bot requests ---------------------------------------------------------

async function loadBotRequestContext(requestId: string) {
  const [row] = await db
    .select({
      id: botRequests.id,
      kind: botRequests.kind,
      title: botRequests.title,
      status: botRequests.status,
      expiresAt: botRequests.expiresAt,
      createdAt: botRequests.createdAt,
      conversationId: botRequests.conversationId,
      threadId: botRequests.threadId,
      audienceUserId: botRequests.audienceUserId,
      triggerSenderId: messages.senderId,
      botName: users.name,
      conversationType: conversations.type,
      workspaceId: conversations.workspaceId,
    })
    .from(botRequests)
    .innerJoin(bots, eq(bots.id, botRequests.botId))
    .innerJoin(users, eq(users.id, bots.userId))
    .innerJoin(conversations, eq(conversations.id, botRequests.conversationId))
    .leftJoin(botInvocations, eq(botInvocations.id, botRequests.invocationId))
    .leftJoin(messages, eq(messages.id, botInvocations.triggerMessageId))
    .where(eq(botRequests.id, requestId))
    .limit(1);
  return row ?? null;
}

type BotRequestContext = NonNullable<Awaited<ReturnType<typeof loadBotRequestContext>>>;

/**
 * The named audience, else everyone in a direct conversation, else the person
 * whose message started the agent run. A channel is never broadcast.
 */
function requestAudience(context: BotRequestContext): string[] | undefined {
  if (context.audienceUserId) return [context.audienceUserId];
  if (context.conversationType === "direct") return undefined;
  return context.triggerSenderId ? [context.triggerSenderId] : [];
}

function requestIsOpen(context: BotRequestContext) {
  return (
    context.status === "open" &&
    (!context.expiresAt || context.expiresAt.getTime() > Date.now())
  );
}

export async function planBotRequestRecipients(
  requestId: string,
): Promise<PlannedRecipient[]> {
  const context = await loadBotRequestContext(requestId);
  if (!context || !requestIsOpen(context)) return [];
  const participants = await activeHumanParticipants(
    context.conversationId,
    context.workspaceId,
    { onlyUserIds: requestAudience(context) },
  );
  const planned: PlannedRecipient[] = [];
  for (const participant of participants) {
    const preferences = await getNotificationPreferences(participant.userId);
    if (preferences.agentRequests) {
      planned.push({ userId: participant.userId, kind: "agent_request" });
    }
  }
  return planned;
}

async function buildBotRequestPayload(
  requestId: string,
  userId: string,
): Promise<PushNotificationPayload | null> {
  const context = await loadBotRequestContext(requestId);
  if (!context || !requestIsOpen(context)) return null;
  const audience = requestAudience(context);
  if (audience && !audience.includes(userId)) return null;
  const [recipient] = await activeHumanParticipants(
    context.conversationId,
    context.workspaceId,
    { onlyUserIds: [userId] },
  );
  if (!recipient) return null;
  const preferences = await getNotificationPreferences(userId);
  if (!preferences.agentRequests) return null;

  const title =
    context.kind === "approval"
      ? `${context.botName} needs your approval`
      : context.kind === "question"
        ? `${context.botName} has a question`
        : `${context.botName} needs a review`;
  return {
    v: 1,
    id: `request:${context.id}`,
    kind: "agent_request",
    title: clampTitle(title),
    body: preferences.showPreviews
      ? previewText(context.title)
      : "Open TheChat to respond",
    tag: `request:${context.id}`,
    url: openConversationUrl(context),
    timestamp: context.createdAt.getTime(),
    badge: await unreadBadge(userId),
  };
}

// -- Entry point ---------------------------------------------------------------

export async function buildPushPayload(
  source: PushSource,
  userId: string,
): Promise<PushNotificationPayload | null> {
  switch (source.type) {
    case "message":
      return buildMessagePayload(source.messageId, source.invocationId, userId);
    case "bot_request":
      return buildBotRequestPayload(source.requestId, userId);
    case "test":
      return {
        v: 1,
        id: `test:${source.nonce}`,
        kind: "test",
        title: "TheChat",
        body: "Notifications work on this device.",
        tag: "test",
        url: "#/settings",
        timestamp: Date.now(),
      };
  }
}
