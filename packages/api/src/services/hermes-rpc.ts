import { eq } from "drizzle-orm";
import type { HermesRpcSessionsResponse } from "@thechat/shared";
import { db } from "../db";
import { bots, hermesRpcBotConfigs } from "../db/schema";
import {
  listHermesRpcSessions as callSessionList,
  redactHermesRpcText,
} from "./hermes-rpc-client";
import { decryptSecret } from "./secrets";
import { ServiceError } from "./errors";

/**
 * Proxy the single read-only RPC supported by the Direct Hermes MVP.
 * Session catalogs are private to the person who owns the configured bot.
 */
export async function listDirectHermesSessions(
  botId: string,
  userId: string,
): Promise<HermesRpcSessionsResponse> {
  const [row] = await db
    .select({
      ownerId: bots.ownerId,
      kind: bots.kind,
      endpoint: hermesRpcBotConfigs.endpoint,
      gatewayTokenEncrypted: hermesRpcBotConfigs.gatewayTokenEncrypted,
    })
    .from(bots)
    .leftJoin(
      hermesRpcBotConfigs,
      eq(hermesRpcBotConfigs.botId, bots.id),
    )
    .where(eq(bots.id, botId))
    .limit(1);

  if (!row) throw new ServiceError("Bot not found", 404);
  if (row.kind !== "hermes-rpc") {
    throw new ServiceError("Bot is not a Direct Hermes bot", 400);
  }
  if (row.ownerId !== userId) {
    throw new ServiceError(
      "Only the bot owner can browse its Hermes sessions",
      403,
    );
  }
  if (!row.endpoint || !row.gatewayTokenEncrypted) {
    throw new ServiceError("Direct Hermes connection is not configured", 409);
  }

  let gatewayToken: string;
  try {
    gatewayToken = decryptSecret(row.gatewayTokenEncrypted);
  } catch {
    throw new ServiceError("Direct Hermes credential could not be decrypted", 500);
  }

  try {
    const sessions = await callSessionList(row.endpoint, gatewayToken);
    return {
      sessions: sessions.map((session) => ({
        id: session.id,
        resolvedId: session.resolved_id ?? null,
        title: session.title,
        preview: session.preview,
        startedAt: session.started_at,
        messageCount: session.message_count,
        source: session.source,
      })),
    };
  } catch (error) {
    throw new ServiceError(
      `Hermes sessions are unavailable: ${redactHermesRpcText(error, gatewayToken)}`,
      502,
    );
  }
}
