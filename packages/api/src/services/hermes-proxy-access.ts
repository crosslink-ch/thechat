import { and, eq } from "drizzle-orm";
import {
  getHermesProxyTicketStore,
  type HermesProxyGrantInput,
} from "@thechat/hermes-proxy/tickets";
import { db } from "../db";
import {
  bots,
  conversationParticipants,
  hermesRpcBotConfigs,
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
): Promise<HermesProxyGrantInput> {
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

    const [row] = await tx
      .select({
        botId: bots.id,
        endpoint: hermesRpcBotConfigs.endpoint,
        gatewayTokenEncrypted: hermesRpcBotConfigs.gatewayTokenEncrypted,
      })
      .from(bots)
      .innerJoin(
        hermesRpcBotConfigs,
        eq(hermesRpcBotConfigs.botId, bots.id),
      )
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
      .where(
        and(
          eq(bots.id, botId),
          eq(bots.kind, "hermes-rpc"),
          eq(bots.ownerId, userId),
        ),
      )
      .limit(1);

    if (!row) {
      throw new ServiceError("You are not allowed to talk to this bot", 403);
    }

    return {
      version: 1,
      botId: row.botId,
      conversationId,
      endpoint: row.endpoint,
      gatewayTokenEncrypted: row.gatewayTokenEncrypted,
      userId,
    };
  });
}

export async function issueDirectHermesProxyTicket(
  botId: string,
  conversationId: string,
  userId: string,
) {
  const grant = await authorizedGrant(botId, conversationId, userId);
  const proxyUrl = resolveHermesProxyUrl();
  let issued;
  try {
    issued = await getHermesProxyTicketStore().issue(grant);
  } catch {
    throw new ServiceError("Direct Hermes proxy is unavailable", 503);
  }
  return {
    proxyUrl,
    ticket: issued.ticket,
    expiresAt: new Date(issued.expiresAt).toISOString(),
  };
}
