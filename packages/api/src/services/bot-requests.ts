import crypto from "crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  resolveBotAppearance,
  type BotRequestAnswer,
  type BotRequestBotView,
  type BotRequestInbox,
  type BotRequestKind,
  type BotRequestPublic,
  type BotRequestResponseSpec,
  type BotRequestStatus,
} from "@thechat/shared";
import { db } from "../db";
import {
  botInvocations,
  botRequests,
  bots,
  conversationParticipants,
  conversationThreads,
  conversations,
  users,
  workspaceMembers,
} from "../db/schema";
import { enqueueDomainEvent } from "../events/outbox";
import { publishWsEventToUsers } from "../realtime";
import { schedulePushNotificationsSafely } from "../push/jobs";
import { createOrGetDm } from "./conversations";
import { requireConversationMutationAccess } from "./conversation-mutation-access";
import { ServiceError } from "./errors";
import { createBotRequestAnsweredV1 } from "../bot-requests/events";

export const BOT_REQUEST_KINDS = ["approval", "question", "review"] as const;
export const BOT_REQUEST_STATUSES = [
  "open",
  "answered",
  "delivered",
  "cancelled",
  "expired",
] as const;

export const MAX_BOT_REQUEST_CLIENT_KEY_LENGTH = 255;
export const MAX_BOT_REQUEST_TITLE_LENGTH = 300;
export const MAX_BOT_REQUEST_BODY_LENGTH = 20_000;
export const MAX_BOT_REQUEST_DETAILS_BYTES = 128 * 1024;
export const MAX_BOT_REQUEST_CHOICES = 20;
export const MAX_BOT_REQUEST_CHOICE_LENGTH = 500;
export const MAX_BOT_REQUEST_LABEL_LENGTH = 100;
export const MAX_BOT_REQUEST_TEXT_LENGTH = 10_000;
export const DEFAULT_BOT_REQUEST_TEXT_LENGTH = 4_000;
export const MAX_BOT_REQUEST_COMMENT_LENGTH = 4_000;
export const MAX_BOT_REQUEST_REASON_LENGTH = 500;
export const MAX_BOT_REQUEST_ORDER_GROUP_LENGTH = 255;
export const MAX_BOT_REQUEST_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_BOT_REQUEST_WAIT_SECONDS = 60;
const MAX_OPEN_REQUESTS_PER_BOT = 500;
const RECENT_INBOX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_INBOX_LIMIT = 30;
const CONVERSATION_RESOLVED_LIMIT = 100;
const WAIT_POLL_INTERVAL_MS = 400;

type BotRow = typeof bots.$inferSelect;
type RequestRow = typeof botRequests.$inferSelect;
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface BotRequestActor {
  id: string;
  type: "human" | "bot";
}

export interface CreateBotRequestInput {
  clientKey: string;
  conversationId?: string | null;
  workspaceId?: string | null;
  threadId?: string | null;
  invocationId?: string | null;
  kind: BotRequestKind;
  title: string;
  body?: string | null;
  details?: Record<string, unknown> | null;
  response?: BotRequestResponseSpec | null;
  orderGroup?: string | null;
  audienceUserId?: string | null;
  expiresAt?: Date | null;
}

const answeredByUsers = alias(users, "bot_request_answered_by");
const botUsers = alias(users, "bot_request_bot_user");

const publicSelection = {
  request: botRequests,
  botUserId: bots.userId,
  botName: botUsers.name,
  botAvatarShape: bots.avatarShape,
  botAvatarColor: bots.avatarColor,
  conversationType: conversations.type,
  conversationName: conversations.name,
  workspaceId: conversations.workspaceId,
  threadTitle: conversationThreads.title,
  answeredByName: answeredByUsers.name,
};

type PublicRow = {
  request: RequestRow;
  botUserId: string;
  botName: string;
  botAvatarShape: string | null;
  botAvatarColor: string | null;
  conversationType: "direct" | "group";
  conversationName: string | null;
  workspaceId: string | null;
  threadTitle: string | null;
  answeredByName: string | null;
};

function selectPublicRows() {
  return db
    .select(publicSelection)
    .from(botRequests)
    .innerJoin(bots, eq(botRequests.botId, bots.id))
    .innerJoin(botUsers, eq(bots.userId, botUsers.id))
    .innerJoin(conversations, eq(botRequests.conversationId, conversations.id))
    .leftJoin(
      conversationThreads,
      eq(botRequests.threadId, conversationThreads.id),
    )
    .leftJoin(answeredByUsers, eq(botRequests.answeredBy, answeredByUsers.id));
}

function toPublic(row: PublicRow): BotRequestPublic {
  const request = row.request;
  return {
    id: request.id,
    botId: request.botId,
    botUserId: row.botUserId,
    botName: row.botName,
    botAvatar: resolveBotAppearance(row.botUserId, {
      avatarShape: row.botAvatarShape,
      avatarColor: row.botAvatarColor,
    }),
    conversationId: request.conversationId,
    conversationType: row.conversationType,
    conversationName: row.conversationName,
    workspaceId: row.workspaceId,
    threadId: request.threadId,
    threadTitle: row.threadTitle,
    invocationId: request.invocationId,
    kind: request.kind as BotRequestKind,
    title: request.title,
    body: request.body,
    details: request.details ?? null,
    response: request.responseSpec as unknown as BotRequestResponseSpec,
    orderGroup: request.orderGroup,
    audienceUserId: request.audienceUserId,
    status: request.status as BotRequestStatus,
    answer: (request.answer as BotRequestAnswer | null) ?? null,
    answeredBy:
      request.answeredBy && row.answeredByName
        ? { id: request.answeredBy, name: row.answeredByName }
        : null,
    answeredAt: request.answeredAt?.toISOString() ?? null,
    deliveredAt: request.deliveredAt?.toISOString() ?? null,
    deliveryApplied: request.deliveryApplied,
    deliveryNote: request.deliveryNote,
    cancelReason: request.cancelReason,
    expiresAt: request.expiresAt?.toISOString() ?? null,
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
  };
}

function toBotView(row: PublicRow): BotRequestBotView {
  return { ...toPublic(row), clientKey: row.request.clientKey };
}

async function loadPublicRow(requestId: string): Promise<PublicRow | null> {
  const [row] = await selectPublicRows()
    .where(eq(botRequests.id, requestId))
    .limit(1);
  return (row as PublicRow | undefined) ?? null;
}

export async function loadBotRequestPublic(
  requestId: string,
): Promise<BotRequestPublic | null> {
  const row = await loadPublicRow(requestId);
  return row ? toPublic(row) : null;
}

export async function loadBotRequestBotView(
  requestId: string,
): Promise<BotRequestBotView | null> {
  const row = await loadPublicRow(requestId);
  return row ? toBotView(row) : null;
}

/** Publish the full row to every participant so cards and inboxes converge. */
export async function publishBotRequestUpdate(requestId: string) {
  const row = await loadPublicRow(requestId);
  if (!row) return;
  const participants = await db
    .select({ userId: conversationParticipants.userId })
    .from(conversationParticipants)
    .innerJoin(users, eq(users.id, conversationParticipants.userId))
    .where(
      and(
        eq(conversationParticipants.conversationId, row.request.conversationId),
        eq(users.type, "human"),
      ),
    );
  if (participants.length === 0) return;
  await publishWsEventToUsers(
    participants.map((participant) => participant.userId),
    {
      type: "bot_request_updated",
      conversationId: row.request.conversationId,
      request: toPublic(row),
    },
  );
}

// -- Validation --------------------------------------------------------------

/** Canonical JSON with sorted keys so jsonb key reordering compares equal. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function defaultResponseSpec(kind: BotRequestKind): BotRequestResponseSpec {
  if (kind === "approval") {
    return {
      type: "choice",
      choices: ["approve", "deny"],
      labels: { approve: "Approve", deny: "Deny" },
    };
  }
  if (kind === "review") {
    return {
      type: "choice",
      choices: ["approve", "request_changes"],
      labels: { approve: "Approve", request_changes: "Request changes" },
      allowComment: true,
    };
  }
  return { type: "text", maxLength: DEFAULT_BOT_REQUEST_TEXT_LENGTH };
}

export function normalizeResponseSpec(
  kind: BotRequestKind,
  spec: BotRequestResponseSpec | null | undefined,
): BotRequestResponseSpec {
  const raw = spec ?? defaultResponseSpec(kind);
  const maxLength = raw.maxLength ?? DEFAULT_BOT_REQUEST_TEXT_LENGTH;
  if (
    !Number.isInteger(maxLength) ||
    maxLength < 1 ||
    maxLength > MAX_BOT_REQUEST_TEXT_LENGTH
  ) {
    throw new ServiceError("response.maxLength is out of range", 400);
  }
  if (raw.type === "text") {
    if (raw.choices?.length || raw.multiple || raw.labels) {
      throw new ServiceError("Text responses cannot declare choices", 400);
    }
    return {
      type: "text",
      maxLength,
      ...(raw.allowComment ? { allowComment: true } : {}),
    };
  }
  if (raw.type !== "choice") {
    throw new ServiceError("response.type must be choice or text", 400);
  }
  const choices = raw.choices ?? [];
  if (
    choices.length === 0 ||
    choices.length > MAX_BOT_REQUEST_CHOICES ||
    new Set(choices).size !== choices.length ||
    choices.some(
      (choice) =>
        typeof choice !== "string" ||
        choice.trim().length === 0 ||
        choice !== choice.trim() ||
        choice.length > MAX_BOT_REQUEST_CHOICE_LENGTH,
    )
  ) {
    throw new ServiceError(
      `response.choices must be 1-${MAX_BOT_REQUEST_CHOICES} unique, trimmed, non-empty strings`,
      400,
    );
  }
  let labels: Record<string, string> | undefined;
  if (raw.labels) {
    labels = {};
    for (const [choice, label] of Object.entries(raw.labels)) {
      if (!choices.includes(choice)) {
        throw new ServiceError(`response.labels has an unknown choice: ${choice}`, 400);
      }
      if (
        typeof label !== "string" ||
        !label.trim() ||
        label.length > MAX_BOT_REQUEST_LABEL_LENGTH
      ) {
        throw new ServiceError("response.labels must be short non-empty strings", 400);
      }
      labels[choice] = label.trim();
    }
  }
  return {
    type: "choice",
    choices,
    ...(labels && Object.keys(labels).length > 0 ? { labels } : {}),
    ...(raw.multiple ? { multiple: true } : {}),
    ...(raw.allowText ? { allowText: true, maxLength } : {}),
    ...(raw.allowComment ? { allowComment: true } : {}),
  };
}

/** Validate a human's answer against what the request offered. */
export function normalizeAnswer(
  spec: BotRequestResponseSpec,
  answer: BotRequestAnswer,
): BotRequestAnswer {
  const provided = [
    answer.choice !== undefined,
    answer.choices !== undefined,
    answer.text !== undefined,
  ].filter(Boolean).length;
  if (provided !== 1) {
    throw new ServiceError("Provide exactly one of choice, choices or text", 400);
  }
  let comment: string | undefined;
  if (answer.comment !== undefined) {
    if (!spec.allowComment) {
      throw new ServiceError("This request does not accept a comment", 400);
    }
    const trimmed = answer.comment.trim();
    if (trimmed.length > MAX_BOT_REQUEST_COMMENT_LENGTH) {
      throw new ServiceError("Comment is too long", 400);
    }
    if (trimmed) comment = trimmed;
  }
  const withComment = (value: BotRequestAnswer): BotRequestAnswer =>
    comment ? { ...value, comment } : value;

  const maxLength = spec.maxLength ?? DEFAULT_BOT_REQUEST_TEXT_LENGTH;
  if (answer.text !== undefined) {
    if (spec.type === "choice" && !spec.allowText) {
      throw new ServiceError("This request only accepts one of its choices", 400);
    }
    const text = answer.text.trim();
    if (!text || text.length > maxLength) {
      throw new ServiceError(`Answer text must be 1-${maxLength} characters`, 400);
    }
    return withComment({ text });
  }
  if (spec.type !== "choice") {
    throw new ServiceError("This request expects a text answer", 400);
  }
  const offered = spec.choices ?? [];
  if (answer.choice !== undefined) {
    if (!offered.includes(answer.choice)) {
      throw new ServiceError("That answer was not offered for this request", 400);
    }
    return withComment({ choice: answer.choice });
  }
  const selected = answer.choices ?? [];
  if (
    !spec.multiple ||
    selected.length === 0 ||
    new Set(selected).size !== selected.length ||
    selected.some((choice) => !offered.includes(choice))
  ) {
    throw new ServiceError("Those answers were not offered for this request", 400);
  }
  return withComment({ choices: selected });
}

function boundedOptionalText(
  value: string | null | undefined,
  max: number,
  field: string,
) {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) {
    throw new ServiceError(`${field} must be at most ${max} characters`, 400);
  }
  return trimmed;
}

// -- Lookups -----------------------------------------------------------------

export async function botForUser(userId: string): Promise<BotRow | null> {
  const [bot] = await db.select().from(bots).where(eq(bots.userId, userId)).limit(1);
  return bot ?? null;
}

async function requireBotForActor(actor: BotRequestActor): Promise<BotRow> {
  if (actor.type !== "bot") {
    throw new ServiceError("A bot token is required", 403);
  }
  const bot = await botForUser(actor.id);
  if (!bot) throw new ServiceError("A bot token is required", 403);
  return bot;
}

/** Same participant rule as the rest of TheChat: group views need membership. */
async function canHumanSeeConversation(conversationId: string, userId: string) {
  const [row] = await db
    .select({
      conversationType: conversations.type,
      workspaceMemberUserId: workspaceMembers.userId,
      userType: users.type,
    })
    .from(conversationParticipants)
    .innerJoin(
      conversations,
      eq(conversationParticipants.conversationId, conversations.id),
    )
    .innerJoin(users, eq(users.id, conversationParticipants.userId))
    .leftJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, conversations.workspaceId),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.userId, userId),
      ),
    )
    .limit(1);
  return Boolean(
    row &&
      row.userType === "human" &&
      (row.conversationType === "direct" || row.workspaceMemberUserId),
  );
}

async function requireHumanParticipant(conversationId: string, userId: string) {
  if (!(await canHumanSeeConversation(conversationId, userId))) {
    throw new ServiceError("Bot request not found", 404);
  }
}

/** A bot without a natural conversation asks in its DM with its owner. */
async function ownerDmConversationId(bot: BotRow, workspaceId?: string | null) {
  const botConversations = db
    .select({ conversationId: conversationParticipants.conversationId })
    .from(conversationParticipants)
    .where(eq(conversationParticipants.userId, bot.userId));
  const candidates = await db
    .select({
      id: conversations.id,
      workspaceId: conversations.workspaceId,
      participantCount: sql<number>`(
        SELECT count(*)::int FROM ${conversationParticipants} cp
        WHERE cp.conversation_id = ${conversations.id}
      )`,
    })
    .from(conversations)
    .innerJoin(
      conversationParticipants,
      and(
        eq(conversationParticipants.conversationId, conversations.id),
        eq(conversationParticipants.userId, bot.ownerId),
      ),
    )
    .where(
      and(
        eq(conversations.type, "direct"),
        inArray(conversations.id, botConversations),
        workspaceId ? eq(conversations.workspaceId, workspaceId) : undefined,
      ),
    )
    .orderBy(asc(conversations.createdAt));
  const existing = candidates.find((candidate) => candidate.participantCount === 2);
  if (existing) return existing.id;

  const ownerWorkspaces = db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, bot.ownerId));
  const [shared] = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.userId, bot.userId),
        workspaceId
          ? eq(workspaceMembers.workspaceId, workspaceId)
          : inArray(workspaceMembers.workspaceId, ownerWorkspaces),
      ),
    )
    .orderBy(asc(workspaceMembers.joinedAt))
    .limit(1);
  if (!shared) {
    throw new ServiceError(
      "conversationId is required: the bot shares no workspace with its owner",
      400,
    );
  }
  const dm = await createOrGetDm(shared.workspaceId, bot.ownerId, bot.userId);
  return dm.id;
}

// -- Expiry ------------------------------------------------------------------

/** Close requests whose deadline passed. Lazy on reads, plus a worker sweep. */
export async function expireDueBotRequests(
  filter?: SQL,
): Promise<string[]> {
  const expired = await db
    .update(botRequests)
    .set({ status: "expired", updatedAt: new Date() })
    .where(
      and(
        eq(botRequests.status, "open"),
        lte(botRequests.expiresAt, new Date()),
        filter,
      ),
    )
    .returning({ id: botRequests.id });
  for (const row of expired) {
    await publishBotRequestUpdate(row.id);
  }
  return expired.map((row) => row.id);
}

// -- Bot side ----------------------------------------------------------------

export async function createBotRequest(
  actor: BotRequestActor,
  input: CreateBotRequestInput,
): Promise<{ request: BotRequestBotView; created: boolean }> {
  const bot = await requireBotForActor(actor);
  const clientKey = input.clientKey.trim();
  if (!clientKey || clientKey.length > MAX_BOT_REQUEST_CLIENT_KEY_LENGTH) {
    throw new ServiceError("clientKey is required", 400);
  }
  if (!BOT_REQUEST_KINDS.includes(input.kind)) {
    throw new ServiceError("kind must be approval, question or review", 400);
  }
  const title = input.title.trim();
  if (!title || title.length > MAX_BOT_REQUEST_TITLE_LENGTH) {
    throw new ServiceError(
      `title must be 1-${MAX_BOT_REQUEST_TITLE_LENGTH} characters`,
      400,
    );
  }
  const body = boundedOptionalText(input.body, MAX_BOT_REQUEST_BODY_LENGTH, "body");
  const details = input.details ?? null;
  if (
    details &&
    new TextEncoder().encode(JSON.stringify(details)).byteLength >
      MAX_BOT_REQUEST_DETAILS_BYTES
  ) {
    throw new ServiceError("details is too large", 400);
  }
  const responseSpec = normalizeResponseSpec(input.kind, input.response);
  const orderGroup = boundedOptionalText(
    input.orderGroup,
    MAX_BOT_REQUEST_ORDER_GROUP_LENGTH,
    "orderGroup",
  );
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt) {
    const delta = expiresAt.getTime() - Date.now();
    if (!Number.isFinite(delta) || delta <= 0 || delta > MAX_BOT_REQUEST_EXPIRY_MS) {
      throw new ServiceError("expiresAt must be in the future and within 30 days", 400);
    }
  }

  // Replays first: a retry must succeed even if the run has since ended.
  const [existing] = await db
    .select()
    .from(botRequests)
    .where(and(eq(botRequests.botId, bot.id), eq(botRequests.clientKey, clientKey)))
    .limit(1);
  if (existing) {
    return { request: await requireSameContent(existing, input, {
      title, body, details, responseSpec, orderGroup,
    }), created: false };
  }

  let invocation: typeof botInvocations.$inferSelect | null = null;
  if (input.invocationId) {
    [invocation] = await db
      .select()
      .from(botInvocations)
      .where(eq(botInvocations.id, input.invocationId))
      .limit(1);
    if (!invocation || invocation.botId !== bot.id) {
      throw new ServiceError("Invocation not found for this bot", 404);
    }
  }
  const conversationId =
    input.conversationId ??
    invocation?.conversationId ??
    (await ownerDmConversationId(bot, input.workspaceId));
  if (invocation && invocation.conversationId !== conversationId) {
    throw new ServiceError("Invocation does not belong to this conversation", 400);
  }
  const threadId = input.threadId ?? invocation?.threadId ?? null;

  const [openCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(botRequests)
    .where(and(eq(botRequests.botId, bot.id), eq(botRequests.status, "open")));
  if ((openCount?.count ?? 0) >= MAX_OPEN_REQUESTS_PER_BOT) {
    throw new ServiceError("Too many open requests for this bot", 429);
  }

  const inserted = await db.transaction(async (tx) => {
    await requireConversationMutationAccess(tx, conversationId, bot.userId);
    if (threadId) {
      const [thread] = await tx
        .select({ id: conversationThreads.id })
        .from(conversationThreads)
        .where(
          and(
            eq(conversationThreads.id, threadId),
            eq(conversationThreads.conversationId, conversationId),
          ),
        )
        .limit(1);
      if (!thread) {
        throw new ServiceError("Thread does not belong to this conversation", 400);
      }
    }
    if (input.audienceUserId) {
      const [audience] = await tx
        .select({ userId: conversationParticipants.userId })
        .from(conversationParticipants)
        .innerJoin(users, eq(users.id, conversationParticipants.userId))
        .where(
          and(
            eq(conversationParticipants.conversationId, conversationId),
            eq(conversationParticipants.userId, input.audienceUserId),
            eq(users.type, "human"),
          ),
        )
        .limit(1);
      if (!audience) {
        throw new ServiceError(
          "audienceUserId must be a human participant of the conversation",
          400,
        );
      }
    }
    const now = new Date();
    return tx
      .insert(botRequests)
      .values({
        botId: bot.id,
        conversationId,
        threadId,
        invocationId: invocation?.id ?? null,
        clientKey,
        kind: input.kind,
        title,
        body,
        details,
        responseSpec: responseSpec as unknown as Record<string, unknown>,
        orderGroup,
        audienceUserId: input.audienceUserId ?? null,
        status: "open",
        expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [botRequests.botId, botRequests.clientKey],
      })
      .returning({ id: botRequests.id });
  });

  const insertedId = inserted[0]?.id;
  if (!insertedId) {
    // Lost a concurrent create race with the same clientKey.
    const [winner] = await db
      .select()
      .from(botRequests)
      .where(and(eq(botRequests.botId, bot.id), eq(botRequests.clientKey, clientKey)))
      .limit(1);
    if (!winner) throw new ServiceError("Could not create the request", 500);
    return {
      request: await requireSameContent(winner, input, {
        title, body, details, responseSpec, orderGroup,
      }),
      created: false,
    };
  }
  await publishBotRequestUpdate(insertedId);
  await schedulePushNotificationsSafely({ type: "bot_request", requestId: insertedId });
  return { request: (await loadBotRequestBotView(insertedId))!, created: true };
}

async function requireSameContent(
  existing: RequestRow,
  input: CreateBotRequestInput,
  normalized: {
    title: string;
    body: string | null;
    details: Record<string, unknown> | null;
    responseSpec: BotRequestResponseSpec;
    orderGroup: string | null;
  },
): Promise<BotRequestBotView> {
  const mismatched =
    existing.kind !== input.kind ||
    existing.title !== normalized.title ||
    (existing.body ?? null) !== normalized.body ||
    stableStringify(existing.details ?? null) !== stableStringify(normalized.details) ||
    stableStringify(existing.responseSpec) !== stableStringify(normalized.responseSpec) ||
    (existing.orderGroup ?? null) !== normalized.orderGroup ||
    (input.conversationId && input.conversationId !== existing.conversationId) ||
    (input.threadId && input.threadId !== existing.threadId) ||
    (input.invocationId && input.invocationId !== existing.invocationId) ||
    (input.audienceUserId ?? null) !== (existing.audienceUserId ?? null);
  if (mismatched) {
    throw new ServiceError(
      "clientKey was already used for a different request; requests cannot be changed after creation",
      409,
    );
  }
  if (existing.status === "open" && existing.expiresAt && existing.expiresAt <= new Date()) {
    await expireDueBotRequests(eq(botRequests.id, existing.id));
  }
  return (await loadBotRequestBotView(existing.id))!;
}

async function requireOwnedRequest(bot: BotRow, requestId: string) {
  const [row] = await db
    .select()
    .from(botRequests)
    .where(and(eq(botRequests.id, requestId), eq(botRequests.botId, bot.id)))
    .limit(1);
  if (!row) throw new ServiceError("Bot request not found", 404);
  return row;
}

export async function listBotRequestsForBot(
  actor: BotRequestActor,
  options: { statuses?: BotRequestStatus[]; limit?: number } = {},
): Promise<BotRequestBotView[]> {
  const bot = await requireBotForActor(actor);
  await expireDueBotRequests(eq(botRequests.botId, bot.id));
  const limit = Math.max(1, Math.min(options.limit ?? 100, 200));
  const rows = await selectPublicRows()
    .where(
      and(
        eq(botRequests.botId, bot.id),
        options.statuses?.length
          ? inArray(botRequests.status, options.statuses)
          : undefined,
      ),
    )
    .orderBy(asc(botRequests.createdAt), asc(botRequests.id))
    .limit(limit);
  return (rows as PublicRow[]).map(toBotView);
}

/** Answered but not yet acknowledged; delivered alongside Hermes polling. */
export async function listUndeliveredAnswersForBot(
  botId: string,
  limit = 50,
): Promise<BotRequestBotView[]> {
  const rows = await selectPublicRows()
    .where(and(eq(botRequests.botId, botId), eq(botRequests.status, "answered")))
    .orderBy(asc(botRequests.answeredAt), asc(botRequests.id))
    .limit(Math.max(1, Math.min(limit, 200)));
  return (rows as PublicRow[]).map(toBotView);
}

export async function cancelBotRequest(
  actor: BotRequestActor,
  requestId: string,
  reason: string | null,
): Promise<BotRequestBotView> {
  const bot = await requireBotForActor(actor);
  await requireOwnedRequest(bot, requestId);
  const cancelReason = boundedOptionalText(
    reason,
    MAX_BOT_REQUEST_REASON_LENGTH,
    "reason",
  ) ?? "The bot withdrew this request.";
  const [updated] = await db
    .update(botRequests)
    .set({ status: "cancelled", cancelReason, updatedAt: new Date() })
    .where(and(eq(botRequests.id, requestId), eq(botRequests.status, "open")))
    .returning({ id: botRequests.id });
  const current = (await loadBotRequestBotView(requestId))!;
  if (updated) {
    await publishBotRequestUpdate(requestId);
    return current;
  }
  // Idempotent: cancelling twice is fine. An answered request must be acked.
  if (current.status === "cancelled" || current.status === "expired") return current;
  throw new BotRequestConflictError(
    current.status === "answered"
      ? "The request was already answered; acknowledge it instead"
      : "The request is no longer open",
    current,
  );
}

export async function acknowledgeBotRequest(
  actor: BotRequestActor,
  requestId: string,
  input: { applied: boolean; note?: string | null },
): Promise<BotRequestBotView> {
  const bot = await requireBotForActor(actor);
  await requireOwnedRequest(bot, requestId);
  const deliveryNote = boundedOptionalText(
    input.note,
    MAX_BOT_REQUEST_REASON_LENGTH,
    "note",
  );
  const now = new Date();
  const [updated] = await db
    .update(botRequests)
    .set({
      status: "delivered",
      deliveredAt: now,
      deliveryApplied: input.applied,
      deliveryNote,
      updatedAt: now,
    })
    .where(and(eq(botRequests.id, requestId), eq(botRequests.status, "answered")))
    .returning({ id: botRequests.id });
  const current = (await loadBotRequestBotView(requestId))!;
  if (updated) {
    await publishBotRequestUpdate(requestId);
    return current;
  }
  if (current.status === "delivered") return current;
  throw new BotRequestConflictError(
    current.status === "open"
      ? "The request has not been answered yet"
      : "The request is no longer waiting for delivery",
    current,
  );
}

// -- Reading (bot or human) --------------------------------------------------

export async function getBotRequestForActor(
  actor: BotRequestActor,
  requestId: string,
): Promise<BotRequestPublic | BotRequestBotView> {
  await expireDueBotRequests(eq(botRequests.id, requestId));
  const row = await loadPublicRow(requestId);
  if (!row) throw new ServiceError("Bot request not found", 404);
  if (actor.type === "bot") {
    const bot = await requireBotForActor(actor);
    if (row.request.botId !== bot.id) {
      throw new ServiceError("Bot request not found", 404);
    }
    return toBotView(row);
  }
  await requireHumanParticipant(row.request.conversationId, actor.id);
  return toPublic(row);
}

/**
 * Long-poll: return as soon as the status differs from the one seen at entry,
 * or after `waitSeconds`, whichever comes first.
 */
export async function waitForBotRequest(
  actor: BotRequestActor,
  requestId: string,
  waitSeconds: number,
  signal?: AbortSignal,
): Promise<BotRequestPublic | BotRequestBotView> {
  const initial = await getBotRequestForActor(actor, requestId);
  const seconds = Math.max(0, Math.min(waitSeconds, MAX_BOT_REQUEST_WAIT_SECONDS));
  if (seconds === 0 || initial.status !== "open") return initial;
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline && !signal?.aborted) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(WAIT_POLL_INTERVAL_MS, deadline - Date.now())),
    );
    const [row] = await db
      .select({ status: botRequests.status, expiresAt: botRequests.expiresAt })
      .from(botRequests)
      .where(eq(botRequests.id, requestId))
      .limit(1);
    if (!row) throw new ServiceError("Bot request not found", 404);
    if (row.status === "open" && row.expiresAt && row.expiresAt <= new Date()) {
      await expireDueBotRequests(eq(botRequests.id, requestId));
      break;
    }
    if (row.status !== initial.status) break;
  }
  return getBotRequestForActor(actor, requestId);
}

// -- Human side --------------------------------------------------------------

export class BotRequestConflictError extends ServiceError {
  constructor(message: string, public readonly request: BotRequestPublic) {
    super(message, 409);
  }
}

export async function answerBotRequest(
  actor: BotRequestActor,
  requestId: string,
  rawAnswer: BotRequestAnswer,
): Promise<BotRequestPublic> {
  if (actor.type !== "human") {
    throw new ServiceError("Only people can answer bot requests", 403);
  }
  await expireDueBotRequests(eq(botRequests.id, requestId));
  const row = await loadPublicRow(requestId);
  if (!row) throw new ServiceError("Bot request not found", 404);
  await requireHumanParticipant(row.request.conversationId, actor.id);
  if (row.request.audienceUserId && row.request.audienceUserId !== actor.id) {
    throw new ServiceError("This request is addressed to someone else", 403);
  }
  if (row.request.status !== "open") {
    throw new BotRequestConflictError(conflictMessage(toPublic(row)), toPublic(row));
  }
  const answer = normalizeAnswer(
    row.request.responseSpec as unknown as BotRequestResponseSpec,
    rawAnswer,
  );

  if (row.request.orderGroup) {
    const [earlier] = await db
      .select({ id: botRequests.id })
      .from(botRequests)
      .where(
        and(
          eq(botRequests.botId, row.request.botId),
          eq(botRequests.orderGroup, row.request.orderGroup),
          eq(botRequests.kind, row.request.kind),
          eq(botRequests.status, "open"),
          or(
            sql`${botRequests.createdAt} < ${row.request.createdAt.toISOString()}`,
            and(
              eq(botRequests.createdAt, row.request.createdAt),
              sql`${botRequests.id} < ${row.request.id}`,
            ),
          ),
          or(isNull(botRequests.expiresAt), gt(botRequests.expiresAt, new Date())),
        ),
      )
      .limit(1);
    if (earlier) {
      throw new ServiceError("An earlier request must be answered first", 409);
    }
  }

  const answered = await db.transaction(async (tx: DbTransaction) => {
    const now = new Date();
    const [updated] = await tx
      .update(botRequests)
      .set({
        status: "answered",
        answer: answer as Record<string, unknown>,
        answeredBy: actor.id,
        answeredAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(botRequests.id, requestId),
          eq(botRequests.status, "open"),
          or(isNull(botRequests.expiresAt), gt(botRequests.expiresAt, now)),
        ),
      )
      .returning();
    if (!updated) return null;
    await enqueueDomainEvent(
      tx,
      createBotRequestAnsweredV1({
        requestId: updated.id,
        botId: updated.botId,
        answeredBy: actor.id,
        workspaceId: row.workspaceId,
      }),
      // One partition per bot keeps answers in answer order for that bot.
      { partitionKey: `bot-request:${updated.botId}` },
    );
    return updated;
  });

  if (!answered) {
    await expireDueBotRequests(eq(botRequests.id, requestId));
    const current = (await loadBotRequestPublic(requestId))!;
    throw new BotRequestConflictError(conflictMessage(current), current);
  }
  await publishBotRequestUpdate(requestId);
  return (await loadBotRequestPublic(requestId))!;
}

function conflictMessage(request: BotRequestPublic) {
  if (request.status === "answered" || request.status === "delivered") {
    return request.answeredBy
      ? `Already answered by ${request.answeredBy.name}`
      : "Already answered";
  }
  if (request.status === "expired") return "Nobody answered in time";
  if (request.status === "cancelled") {
    return request.cancelReason ?? "The bot withdrew this request";
  }
  return "The request is no longer open";
}

function visibleToHuman(userId: string) {
  return and(
    sql`EXISTS (
      SELECT 1 FROM ${conversationParticipants} cp
      WHERE cp.conversation_id = ${botRequests.conversationId}
        AND cp.user_id = ${userId}
    )`,
    or(
      eq(conversations.type, "direct"),
      sql`EXISTS (
        SELECT 1 FROM ${workspaceMembers} wm
        WHERE wm.workspace_id = ${conversations.workspaceId}
          AND wm.user_id = ${userId}
      )`,
    ),
  );
}

export async function listInbox(actor: BotRequestActor): Promise<BotRequestInbox> {
  if (actor.type !== "human") {
    throw new ServiceError("A human user is required", 403);
  }
  await expireDueBotRequests();
  const [open, recent] = await Promise.all([
    selectPublicRows()
      .where(
        and(
          eq(botRequests.status, "open"),
          visibleToHuman(actor.id),
          or(isNull(botRequests.audienceUserId), eq(botRequests.audienceUserId, actor.id)),
        ),
      )
      .orderBy(asc(botRequests.createdAt), asc(botRequests.id))
      .limit(500),
    selectPublicRows()
      .where(
        and(
          inArray(botRequests.status, ["answered", "delivered", "cancelled", "expired"]),
          visibleToHuman(actor.id),
          gt(botRequests.updatedAt, new Date(Date.now() - RECENT_INBOX_WINDOW_MS)),
        ),
      )
      .orderBy(desc(botRequests.updatedAt), desc(botRequests.id))
      .limit(RECENT_INBOX_LIMIT),
  ]);
  return {
    open: (open as PublicRow[]).map(toPublic),
    recent: (recent as PublicRow[]).map(toPublic),
  };
}

/** Every open request plus recent resolved ones, for inline thread cards. */
export async function listConversationBotRequests(
  actor: BotRequestActor,
  conversationId: string,
): Promise<BotRequestPublic[]> {
  if (actor.type !== "human") {
    throw new ServiceError("A human user is required", 403);
  }
  await requireHumanParticipant(conversationId, actor.id);
  await expireDueBotRequests(eq(botRequests.conversationId, conversationId));
  const [open, resolved] = await Promise.all([
    selectPublicRows()
      .where(
        and(
          eq(botRequests.conversationId, conversationId),
          eq(botRequests.status, "open"),
        ),
      )
      .orderBy(asc(botRequests.createdAt), asc(botRequests.id))
      .limit(500),
    selectPublicRows()
      .where(
        and(
          eq(botRequests.conversationId, conversationId),
          inArray(botRequests.status, ["answered", "delivered", "cancelled", "expired"]),
        ),
      )
      .orderBy(desc(botRequests.createdAt), desc(botRequests.id))
      .limit(CONVERSATION_RESOLVED_LIMIT),
  ]);
  return [...(open as PublicRow[]), ...(resolved as PublicRow[])]
    .map(toPublic)
    .sort(
      (left, right) =>
        Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
        left.id.localeCompare(right.id),
    );
}

/**
 * Safety net for Hermes runs: when a run ends, every prompt it was blocked on
 * has already woken (the gateway unregisters its waiters at turn end), so any
 * request still open would be a dead card. Hermes normally cancels these
 * itself; this covers a lost cancel call.
 */
export async function cancelOpenBotRequestsForInvocation(
  invocationId: string,
  reason: string,
): Promise<string[]> {
  const cancelled = await db
    .update(botRequests)
    .set({ status: "cancelled", cancelReason: reason, updatedAt: new Date() })
    .where(
      and(eq(botRequests.invocationId, invocationId), eq(botRequests.status, "open")),
    )
    .returning({ id: botRequests.id });
  for (const row of cancelled) await publishBotRequestUpdate(row.id);
  return cancelled.map((row) => row.id);
}

export function newBotRequestIdempotencyKey() {
  return crypto.randomUUID();
}
