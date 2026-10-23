import { and, eq } from "drizzle-orm";
import type {
  ConversationThreadPublic,
  TaskProjectPublic,
  WsServerEvent,
} from "@thechat/shared";
import { db } from "../db";
import {
  conversationParticipants,
  conversationThreads,
  taskProjects,
} from "../db/schema";
import { log } from "../logging";
import { publishWsEventToUsers } from "../realtime";
import type { ConversationMutationAccess } from "./conversation-mutation-access";
import { ServiceError } from "./errors";

/**
 * Leaf helpers shared by the conversation, project and bot-runtime services.
 * Kept free of service imports so none of them form an import cycle.
 */

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const projectLog = log.child({ component: "task-projects" });

/**
 * Locks the project against concurrent deletion and proves it belongs to the
 * conversation. The foreign key alone would accept another conversation's
 * project.
 */
export async function requireTaskProjectInConversation(
  tx: DbTransaction,
  conversationId: string,
  projectId: string,
) {
  const [project] = await tx
    .select({ id: taskProjects.id })
    .from(taskProjects)
    .where(
      and(
        eq(taskProjects.id, projectId),
        eq(taskProjects.conversationId, conversationId),
      ),
    )
    .for("key share")
    .limit(1);
  if (!project) throw new ServiceError("Project not found", 404);
}

/** Organizing and deleting tasks is for people; bots may read projects. */
export function requireHuman(access: ConversationMutationAccess) {
  if (access.senderType !== "human") {
    throw new ServiceError("Only people can organize or delete tasks", 403);
  }
  return access;
}

export async function publishToConversation(
  conversationId: string,
  event: WsServerEvent,
) {
  try {
    const participants = await db
      .select({ userId: conversationParticipants.userId })
      .from(conversationParticipants)
      .where(eq(conversationParticipants.conversationId, conversationId));
    await publishWsEventToUsers(
      participants.map((participant) => participant.userId),
      event,
    );
  } catch (error) {
    // The mutation has committed; fanout failure must not make it look failed.
    projectLog.warn(
      { err: error, eventType: event.type, conversationId },
      "conversation.realtime_publish_failed",
    );
  }
}

export function toPublicTaskProject(
  project: typeof taskProjects.$inferSelect,
): TaskProjectPublic {
  return {
    id: project.id,
    conversationId: project.conversationId,
    name: project.name,
    createdById: project.createdById,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

export function toPublicConversationThread(
  thread: typeof conversationThreads.$inferSelect,
): ConversationThreadPublic {
  return {
    id: thread.id,
    conversationId: thread.conversationId,
    botId: thread.botId,
    title: thread.title,
    status: thread.status,
    branchPending: thread.branchPending,
    branchFromThreadId: thread.branchFromThreadId,
    projectId: thread.projectId,
    createdById: thread.createdById,
    lastActivityAt: thread.lastActivityAt.toISOString(),
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
  };
}

export function isUniqueViolation(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (
      typeof current === "object" &&
      "code" in current &&
      (current as { code?: unknown }).code === "23505"
    ) {
      return true;
    }
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : null;
  }
  return false;
}
