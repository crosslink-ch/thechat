import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { workspaceConfigs, workspaceMembers, workspaces } from "../db/schema";
import { ServiceError } from "./errors";
import type { WorkspaceConfig, WorkspaceProvider, ReasoningEffort } from "@thechat/shared";

// -- Helpers --

async function requireMembership(workspaceId: string, userId: string) {
  const [membership] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      )
    )
    .limit(1);

  if (!membership) {
    const [ws] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);

    if (!ws) throw new ServiceError("Workspace not found", 404);
    throw new ServiceError("You are not a member of this workspace", 403);
  }

  return membership;
}

function requireAdminOrOwner(role: string) {
  if (role !== "owner" && role !== "admin") {
    throw new ServiceError(
      "Only owners and admins can manage workspace configuration",
      403
    );
  }
}

function toWorkspaceConfig(
  workspaceId: string,
  row: typeof workspaceConfigs.$inferSelect | null
): WorkspaceConfig {
  if (!row) {
    return {
      workspaceId,
      provider: null,
      openrouter: null,
      openrouterModel: null,
      codexModel: null,
      reasoningEffort: null,
      updatedAt: new Date().toISOString(),
    };
  }

  return {
    workspaceId: row.workspaceId,
    provider: row.provider as WorkspaceProvider | null,
    openrouter: row.openrouterApiKey
      ? { apiKey: row.openrouterApiKey }
      : null,
    openrouterModel: row.openrouterModel ?? null,
    codexModel: row.codexModel ?? null,
    reasoningEffort: (row.reasoningEffort as ReasoningEffort) ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// -- Public API --

export async function getWorkspaceConfig(
  workspaceId: string,
  userId: string
): Promise<WorkspaceConfig> {
  await requireMembership(workspaceId, userId);

  const [row] = await db
    .select()
    .from(workspaceConfigs)
    .where(eq(workspaceConfigs.workspaceId, workspaceId))
    .limit(1);

  return toWorkspaceConfig(workspaceId, row ?? null);
}

export async function setOpenRouterConfig(
  workspaceId: string,
  userId: string,
  apiKey: string
): Promise<WorkspaceConfig> {
  const membership = await requireMembership(workspaceId, userId);
  requireAdminOrOwner(membership.role);

  const [existing] = await db
    .select({ workspaceId: workspaceConfigs.workspaceId })
    .from(workspaceConfigs)
    .where(eq(workspaceConfigs.workspaceId, workspaceId))
    .limit(1);

  if (existing) {
    await db
      .update(workspaceConfigs)
      .set({
        provider: "openrouter",
        openrouterApiKey: apiKey,
      })
      .where(eq(workspaceConfigs.workspaceId, workspaceId));
  } else {
    await db.insert(workspaceConfigs).values({
      workspaceId,
      provider: "openrouter",
      openrouterApiKey: apiKey,
    });
  }

  return getWorkspaceConfig(workspaceId, userId);
}

export async function setActiveProvider(
  workspaceId: string,
  userId: string,
  provider: WorkspaceProvider
): Promise<WorkspaceConfig> {
  const membership = await requireMembership(workspaceId, userId);
  requireAdminOrOwner(membership.role);

  const [existing] = await db
    .select()
    .from(workspaceConfigs)
    .where(eq(workspaceConfigs.workspaceId, workspaceId))
    .limit(1);

  if (!existing) {
    throw new ServiceError(
      "No configuration exists yet. Set up a provider first.",
      400
    );
  }

  if (provider === "openrouter" && !existing.openrouterApiKey) {
    throw new ServiceError("OpenRouter API key not configured", 400);
  }

  await db
    .update(workspaceConfigs)
    .set({ provider })
    .where(eq(workspaceConfigs.workspaceId, workspaceId));

  return getWorkspaceConfig(workspaceId, userId);
}

export async function updateWorkspaceSettings(
  workspaceId: string,
  userId: string,
  settings: {
    openrouterModel?: string | null;
    codexModel?: string | null;
    reasoningEffort?: ReasoningEffort | null;
  }
): Promise<WorkspaceConfig> {
  const membership = await requireMembership(workspaceId, userId);
  requireAdminOrOwner(membership.role);

  const [existing] = await db
    .select({ workspaceId: workspaceConfigs.workspaceId })
    .from(workspaceConfigs)
    .where(eq(workspaceConfigs.workspaceId, workspaceId))
    .limit(1);

  const updates: Record<string, unknown> = {};
  if ("openrouterModel" in settings) updates.openrouterModel = settings.openrouterModel ?? null;
  if ("codexModel" in settings) updates.codexModel = settings.codexModel ?? null;
  if ("reasoningEffort" in settings) updates.reasoningEffort = settings.reasoningEffort ?? null;

  if (existing) {
    await db
      .update(workspaceConfigs)
      .set(updates)
      .where(eq(workspaceConfigs.workspaceId, workspaceId));
  } else {
    await db.insert(workspaceConfigs).values({
      workspaceId,
      ...updates,
    });
  }

  return getWorkspaceConfig(workspaceId, userId);
}

export async function deleteWorkspaceConfig(
  workspaceId: string,
  userId: string
): Promise<void> {
  const membership = await requireMembership(workspaceId, userId);
  requireAdminOrOwner(membership.role);

  await db
    .delete(workspaceConfigs)
    .where(eq(workspaceConfigs.workspaceId, workspaceId));
}
