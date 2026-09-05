import { and, eq, inArray, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DirectHermesSettings } from "@thechat/shared";
import { db } from "../db";
import {
  bots,
  hermesRpcBotConfigs,
  hermesRpcAllowedUsers,
  users,
  workspaceMembers,
} from "../db/schema";
import { ServiceError } from "./errors";
import { encryptSecret } from "@thechat/hermes-proxy/secrets";
import { assertHermesGatewayEndpointAllowed } from "@thechat/hermes-proxy/endpoint";
import { z } from "zod";
import { hermesGatewayTokenSchema } from "./hermes-rpc-config";
import { publishDirectHermesRevision } from "./hermes-proxy-revocation";

export const directHermesSettingsPatchSchema = z
  .object({
    allowedUserIds: z.array(z.string().uuid()).max(1000).optional(),
    acknowledgeSharedAccess: z.boolean().optional(),
    revision: z.string().regex(/^[1-9][0-9]{0,9}$/),
    endpoint: z.string().trim().min(1).max(2048).optional(),
    gatewayToken: hermesGatewayTokenSchema.optional(),
  })
  .strict();

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function ownerConfig(tx: Tx, botId: string, userId: string) {
  const [row] = await tx
    .select({
      botId: bots.id,
      ownerId: bots.ownerId,
      botUserId: bots.userId,
      endpoint: hermesRpcBotConfigs.endpoint,
      gatewayTokenEncrypted: hermesRpcBotConfigs.gatewayTokenEncrypted,
      revision: hermesRpcBotConfigs.revision,
    })
    .from(hermesRpcBotConfigs)
    .innerJoin(bots, eq(bots.id, hermesRpcBotConfigs.botId))
    .innerJoin(users, and(eq(users.id, bots.ownerId), eq(users.type, "human")))
    .where(
      and(
        eq(bots.id, botId),
        eq(bots.kind, "hermes-rpc"),
        eq(bots.ownerId, userId),
      ),
    )
    .for("update", { of: hermesRpcBotConfigs })
    .limit(1);
  if (!row)
    throw new ServiceError(
      "Only the Direct Hermes bot owner can manage settings",
      403,
    );
  return row;
}
async function safeSettings(
  tx: Tx,
  row: Awaited<ReturnType<typeof ownerConfig>>,
): Promise<DirectHermesSettings> {
  const ownerMembership = alias(workspaceMembers, "hermes_owner_membership");
  const botMembership = alias(workspaceMembers, "hermes_bot_membership");
  const eligibleUsers = await tx
    .selectDistinct({ id: users.id, name: users.name })
    .from(users)
    .innerJoin(workspaceMembers, eq(workspaceMembers.userId, users.id))
    .innerJoin(
      ownerMembership,
      and(
        eq(ownerMembership.workspaceId, workspaceMembers.workspaceId),
        eq(ownerMembership.userId, row.ownerId),
      ),
    )
    .innerJoin(
      botMembership,
      and(
        eq(botMembership.workspaceId, workspaceMembers.workspaceId),
        eq(botMembership.userId, row.botUserId),
      ),
    )
    .where(and(eq(users.type, "human"), ne(users.id, row.ownerId)))
    .orderBy(users.name, users.id);
  const selected = await tx
    .select({ userId: hermesRpcAllowedUsers.userId })
    .from(hermesRpcAllowedUsers)
    .where(eq(hermesRpcAllowedUsers.botId, row.botId))
    .orderBy(hermesRpcAllowedUsers.userId);
  return {
    botId: row.botId,
    endpoint: row.endpoint,
    gatewayTokenConfigured: !!row.gatewayTokenEncrypted,
    allowedUserIds: selected.map((s) => s.userId),
    eligibleUsers,
    revision: String(row.revision),
  };
}
export async function updateDirectHermesSettings(
  botId: string,
  userId: string,
  input: unknown,
): Promise<DirectHermesSettings> {
  const parsed = directHermesSettingsPatchSchema.safeParse(input);
  if (!parsed.success)
    throw new ServiceError("Invalid Direct Hermes settings", 400);
  const update = parsed.data;
  return db.transaction(async (tx) => {
    const row = await ownerConfig(tx, botId, userId);
    if (String(row.revision) !== update.revision)
      throw new ServiceError("Settings changed; reload and retry", 409);
    let endpoint = row.endpoint;
    if (update.endpoint !== undefined) {
      try {
        endpoint = assertHermesGatewayEndpointAllowed(update.endpoint);
      } catch {
        throw new ServiceError("Invalid or disallowed Hermes gateway URL", 400);
      }
    }
    if (endpoint !== row.endpoint && !update.gatewayToken)
      throw new ServiceError(
        "A replacement token is required when changing gateway URL",
        400,
      );
    if (update.allowedUserIds !== undefined) {
      const current = await safeSettings(tx, row);
      const selected = update.allowedUserIds;
      const eligible = new Set(current.eligibleUsers.map((u) => u.id));
      const previous = new Set(current.allowedUserIds);
      // Unavailable selections may be retained by ID, but never nonhumans.
      const humans = selected.length
        ? await tx
            .select({ id: users.id })
            .from(users)
            .where(and(inArray(users.id, selected), eq(users.type, "human")))
        : [];
      if (
        humans.length !== selected.length ||
        new Set(selected).size !== selected.length ||
        selected.some(
          (id) =>
            id === row.ownerId || (!eligible.has(id) && !previous.has(id)),
        )
      ) {
        throw new ServiceError("Select unique eligible human members", 400);
      }
      if (
        selected.some((id) => !previous.has(id)) &&
        update.acknowledgeSharedAccess !== true
      ) {
        throw new ServiceError(
          "Acknowledge that selected humans share the same gateway and sessions",
          400,
        );
      }
      await tx
        .delete(hermesRpcAllowedUsers)
        .where(eq(hermesRpcAllowedUsers.botId, botId));
      if (selected.length)
        await tx
          .insert(hermesRpcAllowedUsers)
          .values(selected.map((userId) => ({ botId, userId })));
    }
    const gatewayTokenEncrypted = update.gatewayToken
      ? encryptSecret(update.gatewayToken)
      : row.gatewayTokenEncrypted;
    const revision = row.revision + 1;
    await tx
      .update(hermesRpcBotConfigs)
      .set({ endpoint, gatewayTokenEncrypted, revision })
      .where(eq(hermesRpcBotConfigs.botId, botId));
    // Publish under the config lock and BEFORE commit: never commit a revocation
    // without its fence. Redis/commit ambiguity may deny access, never restore it.
    await publishDirectHermesRevision(botId, revision);
    return safeSettings(tx, {
      ...row,
      endpoint,
      gatewayTokenEncrypted,
      revision,
    });
  });
}

export async function getDirectHermesSettings(
  botId: string,
  userId: string,
): Promise<DirectHermesSettings> {
  return db.transaction(async (tx) =>
    safeSettings(tx, await ownerConfig(tx, botId, userId)),
  );
}
