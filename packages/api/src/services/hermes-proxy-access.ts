import { and, eq, or, exists } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  getHermesProxyTicketStore,
  type IssuedHermesProxyTicket,
} from "@thechat/hermes-proxy/tickets";
import { db } from "../db";
import {
  bots,
  conversationParticipants,
  hermesRpcBotConfigs,
  hermesRpcAllowedUsers,
  workspaceMembers,
} from "../db/schema";
import { requireConversationMutationAccess } from "./conversation-mutation-access";
import { ServiceError } from "./errors";

function resolveHermesProxyUrl(): string {
  const configured = process.env.THECHAT_HERMES_PROXY_URL?.trim();
  if (!configured) {
    throw new ServiceError("Direct Hermes proxy URL is not configured", 503);
  }

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new ServiceError("Direct Hermes proxy URL is invalid", 503);
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new ServiceError("Direct Hermes proxy URL must use ws or wss", 503);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ServiceError("Direct Hermes proxy URL is invalid", 503);
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!url.pathname.endsWith("/hermes-proxy")) {
    throw new ServiceError(
      "Direct Hermes proxy URL must end with /hermes-proxy",
      503,
    );
  }
  return url.toString().replace(/\/$/, "");
}

async function authorizedGrant(
  botId: string,
  conversationId: string,
  userId: string,
): Promise<IssuedHermesProxyTicket> {
  return db.transaction(async (tx) => {
    const access = await requireConversationMutationAccess(
      tx,
      conversationId,
      userId,
    );
    if (
      access.senderType !== "human" ||
      access.conversationType !== "direct" ||
      !access.workspaceId
    ) {
      throw new ServiceError("You are not allowed to talk to this bot", 403);
    }

    // Workspace -> config lock order. Read grants only AFTER acquiring this
    // lock, so a waiting issuer cannot use a pre-update statement snapshot.
    await tx
      .select({ botId: hermesRpcBotConfigs.botId })
      .from(hermesRpcBotConfigs)
      .where(eq(hermesRpcBotConfigs.botId, botId))
      .for("share");
    const ownerMembership = alias(workspaceMembers, "hermes_owner_membership");
    const [row] = await tx
      .select({
        botId: bots.id,
        revision: hermesRpcBotConfigs.revision,
        endpoint: hermesRpcBotConfigs.endpoint,
        gatewayTokenEncrypted: hermesRpcBotConfigs.gatewayTokenEncrypted,
      })
      .from(bots)
      .innerJoin(hermesRpcBotConfigs, eq(hermesRpcBotConfigs.botId, bots.id))
      .innerJoin(
        conversationParticipants,
        and(
          eq(conversationParticipants.conversationId, conversationId),
          eq(conversationParticipants.userId, bots.userId),
        ),
      )
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, access.workspaceId),
          eq(workspaceMembers.userId, bots.userId),
        ),
      )
      .innerJoin(
        ownerMembership,
        and(
          eq(ownerMembership.workspaceId, access.workspaceId),
          eq(ownerMembership.userId, bots.ownerId),
        ),
      )
      .where(
        and(
          eq(bots.id, botId),
          eq(bots.kind, "hermes-rpc"),
          or(
            eq(bots.ownerId, userId),
            exists(
              tx
                .select({ userId: hermesRpcAllowedUsers.userId })
                .from(hermesRpcAllowedUsers)
                .where(
                  and(
                    eq(hermesRpcAllowedUsers.botId, bots.id),
                    eq(hermesRpcAllowedUsers.userId, userId),
                  ),
                ),
            ),
          ),
        ),
      )
      .limit(1);

    if (!row) {
      throw new ServiceError("You are not allowed to talk to this bot", 403);
    }

    try {
      return await getHermesProxyTicketStore().issue({
        version: 2,
        policyRevision: String(row.revision),
        botId: row.botId,
        conversationId,
        endpoint: row.endpoint,
        gatewayTokenEncrypted: row.gatewayTokenEncrypted,
        userId,
      });
    } catch {
      throw new ServiceError("Direct Hermes proxy is unavailable", 503);
    }
  });
}

export async function issueDirectHermesProxyTicket(
  botId: string,
  conversationId: string,
  userId: string,
) {
  const proxyUrl = resolveHermesProxyUrl();
  const issued = await authorizedGrant(botId, conversationId, userId);
  return {
    proxyUrl,
    ticket: issued.ticket,
    expiresAt: new Date(issued.expiresAt).toISOString(),
  };
}
