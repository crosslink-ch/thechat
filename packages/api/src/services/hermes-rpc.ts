import { and, eq, isNull } from "drizzle-orm";
import type {
  ConversationThreadPublic,
  HermesRpcBotConfigPublic,
  HermesRpcSessionPublic,
} from "@thechat/shared";
import { db } from "../db";
import {
  bots,
  conversationParticipants,
  conversations,
  conversationThreads,
  hermesRpcBotConfigs,
  hermesRpcSessionLinks,
  users,
  workspaceMembers,
} from "../db/schema";
import { decryptSecret, encryptSecret } from "./secrets";
import {
  HermesRpcClient,
  normalizeHermesRpcEndpoint,
  redactHermesRpcText,
  type HermesRpcSessionListItem,
} from "./hermes-rpc-client";
import { ServiceError } from "./errors";

export interface HermesRpcConnection {
  endpoint: string;
  gatewayToken: string | null;
}

function toPublicConfig(row: typeof hermesRpcBotConfigs.$inferSelect): HermesRpcBotConfigPublic {
  return {
    botId: row.botId,
    endpoint: row.endpoint,
    gatewayTokenConfigured: Boolean(row.gatewayTokenEncrypted),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function requireHermesRpcBotOwner(botId: string, userId: string) {
  const [bot] = await db
    .select({ id: bots.id, ownerId: bots.ownerId, kind: bots.kind, name: users.name })
    .from(bots)
    .innerJoin(users, eq(bots.userId, users.id))
    .where(eq(bots.id, botId))
    .limit(1);
  if (!bot) throw new ServiceError("Bot not found", 404);
  if (bot.ownerId !== userId) {
    throw new ServiceError("Only the bot owner can manage this Hermes RPC bot", 403);
  }
  if (bot.kind !== "hermes-rpc") throw new ServiceError("Bot is not a Hermes RPC bot", 400);
  return bot;
}

export async function getHermesRpcConnection(botId: string): Promise<HermesRpcConnection> {
  const [config] = await db
    .select()
    .from(hermesRpcBotConfigs)
    .where(eq(hermesRpcBotConfigs.botId, botId))
    .limit(1);
  if (!config) throw new ServiceError("Hermes RPC connection is not configured", 409);
  return {
    endpoint: config.endpoint,
    gatewayToken: config.gatewayTokenEncrypted
      ? decryptSecret(config.gatewayTokenEncrypted)
      : null,
  };
}

export async function getHermesRpcBotConfig(botId: string, userId: string) {
  await requireHermesRpcBotOwner(botId, userId);
  const [config] = await db
    .select()
    .from(hermesRpcBotConfigs)
    .where(eq(hermesRpcBotConfigs.botId, botId))
    .limit(1);
  if (!config) throw new ServiceError("Hermes RPC connection is not configured", 404);
  return toPublicConfig(config);
}

export async function updateHermesRpcBotConfig(
  botId: string,
  userId: string,
  updates: { endpoint?: string; gatewayToken?: string | null },
) {
  await requireHermesRpcBotOwner(botId, userId);
  const [existing] = await db
    .select()
    .from(hermesRpcBotConfigs)
    .where(eq(hermesRpcBotConfigs.botId, botId))
    .limit(1);
  const endpoint = updates.endpoint !== undefined
    ? normalizeEndpointForService(updates.endpoint)
    : existing?.endpoint;
  if (!endpoint) throw new ServiceError("Hermes RPC endpoint is required", 400);

  const gatewayTokenEncrypted = updates.gatewayToken === undefined
    ? existing?.gatewayTokenEncrypted ?? null
    : updates.gatewayToken?.trim()
      ? encryptSecret(updates.gatewayToken.trim())
      : null;

  const [config] = await db
    .insert(hermesRpcBotConfigs)
    .values({ botId, endpoint, gatewayTokenEncrypted })
    .onConflictDoUpdate({
      target: hermesRpcBotConfigs.botId,
      set: { endpoint, gatewayTokenEncrypted, updatedAt: new Date() },
    })
    .returning();
  return toPublicConfig(config);
}

export async function testHermesRpcBot(botId: string, userId: string) {
  await requireHermesRpcBotOwner(botId, userId);
  const connection = await getHermesRpcConnection(botId);
  const client = new HermesRpcClient(connection.endpoint, connection.gatewayToken);
  const started = Date.now();
  let gatewayReady = false;
  const detachReady = client.on("gateway.ready", () => {
    gatewayReady = true;
  });
  try {
    await client.connect();
    const result = await client.sessionList(1);
    await waitFor(() => gatewayReady, 1_000);
    return {
      ok: true as const,
      endpoint: connection.endpoint,
      gatewayReady,
      sessionListAvailable: true,
      sessionCountSampled: result.sessions.length,
      latencyMs: Date.now() - started,
      gatewayTokenConfigured: Boolean(connection.gatewayToken),
    };
  } catch (error) {
    throw new ServiceError(
      `Hermes RPC connection failed: ${redactHermesRpcText(error, connection.gatewayToken)}`,
      502,
    );
  } finally {
    detachReady();
    client.close();
  }
}

export async function listHermesRpcSessions(input: {
  botId: string;
  conversationId: string;
  userId: string;
}): Promise<{ sessions: HermesRpcSessionPublic[] }> {
  const access = await requireAccessibleHermesRpcDm(input);
  const links = await db
    .select({
      upstreamSessionId: hermesRpcSessionLinks.upstreamSessionId,
      threadId: hermesRpcSessionLinks.threadId,
    })
    .from(hermesRpcSessionLinks)
    .where(
      and(
        eq(hermesRpcSessionLinks.botId, input.botId),
        eq(hermesRpcSessionLinks.conversationId, input.conversationId),
      ),
    );
  const ownerMayBrowseCatalog = access.ownerId === input.userId;
  if (!ownerMayBrowseCatalog && links.length === 0) return { sessions: [] };

  const connection = await getHermesRpcConnection(input.botId);
  const client = new HermesRpcClient(connection.endpoint, connection.gatewayToken);
  try {
    await client.connect();
    const result = await client.sessionList();
    const threadBySession = new Map(
      links.map((link) => [link.upstreamSessionId, link.threadId]),
    );
    if (!ownerMayBrowseCatalog) {
      const upstreamById = new Map(
        result.sessions.map((session) => [session.id, session]),
      );
      return {
        sessions: links.map((link) =>
          toPublicSession(
            upstreamById.get(link.upstreamSessionId) ?? missingLinkedSession(link.upstreamSessionId),
            link.threadId,
            true,
          )),
      };
    }
    return {
      sessions: result.sessions.map((session) =>
        toPublicSession(
          session,
          threadBySession.get(session.id) ?? null,
          threadBySession.has(session.id),
        )),
    };
  } catch (error) {
    throw new ServiceError(
      `Hermes sessions are unavailable: ${redactHermesRpcText(error, connection.gatewayToken)}`,
      502,
    );
  } finally {
    client.close();
  }
}

export async function selectHermesRpcSession(input: {
  botId: string;
  conversationId: string;
  upstreamSessionId: string;
  userId: string;
}) {
  const access = await requireAccessibleHermesRpcDm(input);
  const existing = await findLinkByUpstream(
    input.botId,
    input.conversationId,
    input.upstreamSessionId,
  );
  const ownerMayImport = access.ownerId === input.userId;
  if (!ownerMayImport && !existing) {
    throw new ServiceError("Hermes session not found", 404);
  }

  const connection = await getHermesRpcConnection(input.botId);
  const client = new HermesRpcClient(connection.endpoint, connection.gatewayToken);
  let upstream: HermesRpcSessionListItem;
  try {
    await client.connect();
    const listed = await client.sessionList();
    const found = listed.sessions.find((session) => session.id === input.upstreamSessionId);
    if (!found) throw new ServiceError("Hermes session not found", 404);
    upstream = found;
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(
      `Hermes session could not be selected: ${redactHermesRpcText(error, connection.gatewayToken)}`,
      502,
    );
  } finally {
    client.close();
  }

  if (existing) {
    return { session: toPublicSession(upstream, existing.threadId, true), thread: existing.thread };
  }

  const linkedElsewhere = await findLinkByUpstreamForBot(
    input.botId,
    input.upstreamSessionId,
  );
  if (linkedElsewhere) {
    throw new ServiceError("This Hermes session is already linked to another conversation", 409);
  }

  try {
    const created = await db.transaction(async (tx) => {
      const [thread] = await tx
        .insert(conversationThreads)
        .values({
          conversationId: input.conversationId,
          botId: input.botId,
          title: normalizedSessionTitle(upstream.title),
          createdById: input.userId,
        })
        .returning();
      await tx.insert(hermesRpcSessionLinks).values({
        botId: input.botId,
        conversationId: input.conversationId,
        threadId: thread.id,
        upstreamSessionId: input.upstreamSessionId,
      });
      return thread;
    });
    return {
      session: toPublicSession(upstream, created.id, true),
      thread: toPublicThread(created),
    };
  } catch (error: any) {
    if (error?.code !== "23505") throw error;
    const raced = await findLinkByUpstream(
      input.botId,
      input.conversationId,
      input.upstreamSessionId,
    );
    if (raced) {
      return { session: toPublicSession(upstream, raced.threadId, true), thread: raced.thread };
    }
    const conflict = await findLinkByUpstreamForBot(
      input.botId,
      input.upstreamSessionId,
    );
    if (conflict) {
      throw new ServiceError("This Hermes session is already linked to another conversation", 409);
    }
    throw new ServiceError("The Hermes session link conflicts with another lane", 409);
  }
}

export async function getHermesRpcSessionLink(input: {
  botId: string;
  conversationId: string;
  threadId: string | null;
}) {
  const conditions = [
    eq(hermesRpcSessionLinks.botId, input.botId),
    eq(hermesRpcSessionLinks.conversationId, input.conversationId),
    input.threadId
      ? eq(hermesRpcSessionLinks.threadId, input.threadId)
      : isNull(hermesRpcSessionLinks.threadId),
  ];
  const [link] = await db
    .select()
    .from(hermesRpcSessionLinks)
    .where(and(...conditions))
    .limit(1);
  return link ?? null;
}

export async function linkHermesRpcSession(input: {
  botId: string;
  conversationId: string;
  threadId: string | null;
  upstreamSessionId: string;
}) {
  const laneLink = await getHermesRpcSessionLink(input);
  if (laneLink) {
    if (laneLink.upstreamSessionId !== input.upstreamSessionId) {
      throw new ServiceError("This TheChat lane is already linked to another Hermes session", 409);
    }
    return laneLink;
  }
  const upstreamLink = await findLinkByUpstreamForBot(
    input.botId,
    input.upstreamSessionId,
  );
  if (upstreamLink) {
    throw new ServiceError("This Hermes session is already linked to another conversation", 409);
  }

  const [link] = await db
    .insert(hermesRpcSessionLinks)
    .values(input)
    .onConflictDoNothing()
    .returning();
  if (link) return link;

  const existing = await getHermesRpcSessionLink(input);
  if (existing?.upstreamSessionId === input.upstreamSessionId) return existing;
  if (existing) {
    throw new ServiceError("This TheChat lane is already linked to another Hermes session", 409);
  }
  if (await findLinkByUpstreamForBot(input.botId, input.upstreamSessionId)) {
    throw new ServiceError("This Hermes session is already linked to another conversation", 409);
  }
  throw new ServiceError("The Hermes session link conflicts with another lane", 409);
}

async function requireAccessibleHermesRpcDm(input: {
  botId: string;
  conversationId: string;
  userId: string;
}) {
  const [row] = await db
    .select({
      conversationId: conversations.id,
      conversationType: conversations.type,
      botUserId: bots.userId,
      ownerId: bots.ownerId,
      memberUserId: workspaceMembers.userId,
    })
    .from(conversations)
    .innerJoin(
      conversationParticipants,
      eq(conversationParticipants.conversationId, conversations.id),
    )
    .innerJoin(
      bots,
      and(
        eq(bots.id, input.botId),
        eq(bots.userId, conversationParticipants.userId),
      ),
    )
    .leftJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, conversations.workspaceId),
        eq(workspaceMembers.userId, input.userId),
      ),
    )
    .where(
      and(
        eq(conversations.id, input.conversationId),
        eq(conversations.type, "direct"),
        eq(bots.kind, "hermes-rpc"),
      ),
    )
    .limit(1);
  if (!row) throw new ServiceError("Hermes RPC DM not found", 404);

  const [participant] = await db
    .select({ userId: conversationParticipants.userId })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, input.conversationId),
        eq(conversationParticipants.userId, input.userId),
      ),
    )
    .limit(1);
  if (!participant || !row.memberUserId) {
    throw new ServiceError("You cannot access this Hermes RPC DM", 403);
  }
  return row;
}

async function findLinkByUpstream(
  botId: string,
  conversationId: string,
  upstreamSessionId: string,
) {
  const [row] = await db
    .select({ link: hermesRpcSessionLinks, thread: conversationThreads })
    .from(hermesRpcSessionLinks)
    .leftJoin(conversationThreads, eq(conversationThreads.id, hermesRpcSessionLinks.threadId))
    .where(
      and(
        eq(hermesRpcSessionLinks.botId, botId),
        eq(hermesRpcSessionLinks.conversationId, conversationId),
        eq(hermesRpcSessionLinks.upstreamSessionId, upstreamSessionId),
      ),
    )
    .limit(1);
  return row
    ? { ...row.link, thread: row.thread ? toPublicThread(row.thread) : null }
    : null;
}

async function findLinkByUpstreamForBot(
  botId: string,
  upstreamSessionId: string,
) {
  const [link] = await db
    .select()
    .from(hermesRpcSessionLinks)
    .where(
      and(
        eq(hermesRpcSessionLinks.botId, botId),
        eq(hermesRpcSessionLinks.upstreamSessionId, upstreamSessionId),
      ),
    )
    .limit(1);
  return link ?? null;
}

async function waitFor(predicate: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function normalizeEndpointForService(endpoint: string) {
  try {
    return normalizeHermesRpcEndpoint(endpoint);
  } catch (error) {
    throw new ServiceError(error instanceof Error ? error.message : "Invalid Hermes RPC endpoint", 400);
  }
}

function normalizedSessionTitle(title: string) {
  const normalized = title.trim().replace(/\s+/g, " ");
  return (normalized || "Hermes session").slice(0, 255);
}

function missingLinkedSession(id: string): HermesRpcSessionListItem {
  return {
    id,
    title: "Hermes session",
    preview: "",
    started_at: 0,
    message_count: 0,
    source: "",
  };
}

function toPublicSession(
  session: HermesRpcSessionListItem,
  threadId: string | null,
  linked: boolean,
): HermesRpcSessionPublic {
  return {
    id: session.id,
    title: session.title,
    preview: session.preview,
    startedAt: session.started_at,
    messageCount: session.message_count,
    source: session.source,
    threadId,
    linked,
  };
}

function toPublicThread(thread: typeof conversationThreads.$inferSelect): ConversationThreadPublic {
  return {
    id: thread.id,
    conversationId: thread.conversationId,
    botId: thread.botId,
    title: thread.title,
    status: thread.status,
    branchPending: thread.branchPending,
    branchFromThreadId: thread.branchFromThreadId,
    createdById: thread.createdById,
    lastActivityAt: thread.lastActivityAt.toISOString(),
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
  };
}
