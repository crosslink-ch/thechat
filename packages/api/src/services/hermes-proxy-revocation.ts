import { and, eq, exists, or } from "drizzle-orm";
import { getHermesProxyTicketStore } from "@thechat/hermes-proxy/tickets";
import { db } from "../db";
import {
  bots,
  hermesRpcAllowedUsers,
  hermesRpcBotConfigs,
  workspaceMembers,
} from "../db/schema";
import { ServiceError } from "./errors";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export async function publishDirectHermesRevision(
  botId: string,
  revision: number,
) {
  try {
    await getHermesProxyTicketStore().publishPolicyRevision(
      botId,
      String(revision),
    );
  } catch {
    throw new ServiceError(
      "Direct Hermes proxy is unavailable; change was not saved",
      503,
    );
  }
}

// Call under the enclosing mutation transaction, before committing/deleting.
export async function revokeDirectHermesBot(tx: Tx, botId: string) {
  const [config] = await tx
    .select({ revision: hermesRpcBotConfigs.revision })
    .from(hermesRpcBotConfigs)
    .where(eq(hermesRpcBotConfigs.botId, botId))
    .for("update");
  if (!config) return; // Other bot kinds do not depend on the proxy/Redis.
  const revision = config.revision + 1;
  await tx
    .update(hermesRpcBotConfigs)
    .set({ revision })
    .where(eq(hermesRpcBotConfigs.botId, botId));
  await publishDirectHermesRevision(botId, revision);
}

// Caller holds the workspace FOR UPDATE. Lock order is workspace -> config.
// Revoke only Direct Hermes bots whose authority depends on the removed member.
export async function revokeDirectHermesWorkspaceAccess(
  tx: Tx,
  workspaceId: string,
  userId: string,
) {
  const affected = await tx
    .select({ id: bots.id })
    .from(bots)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, bots.userId),
      ),
    )
    .where(
      and(
        eq(bots.kind, "hermes-rpc"),
        or(
          eq(bots.userId, userId),
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
    .orderBy(bots.id);
  for (const bot of affected) await revokeDirectHermesBot(tx, bot.id);
}
