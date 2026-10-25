import { and, asc, desc, eq } from "drizzle-orm";
import type { TaskProjectDetail, TaskProjectPublic } from "@thechat/shared";
import { db } from "../db";
import { conversationThreads, taskProjects } from "../db/schema";
import { requireConversationMutationAccess } from "./conversation-mutation-access";
import { requireConversationParticipant } from "./conversations";
import { ServiceError } from "./errors";
import {
  isUniqueViolation,
  publishToConversation,
  requireHuman,
  toPublicConversationThread,
  toPublicTaskProject,
} from "./task-project-records";

export const MAX_TASK_PROJECT_NAME_LENGTH = 100;
const MAX_PROJECT_DETAIL_TASKS = 100;

export async function listTaskProjects(
  conversationId: string,
  userId: string,
): Promise<TaskProjectPublic[]> {
  await requireConversationParticipant(conversationId, userId);
  const rows = await db
    .select()
    .from(taskProjects)
    .where(eq(taskProjects.conversationId, conversationId))
    .orderBy(asc(taskProjects.createdAt), asc(taskProjects.id));
  return rows.map(toPublicTaskProject);
}

/**
 * A project and the tasks filed under it. Bots in the conversation can read
 * this, which is how Hermes discovers sibling tasks of the one it works on.
 */
export async function getTaskProject(
  conversationId: string,
  projectId: string,
  userId: string,
): Promise<TaskProjectDetail> {
  await requireConversationParticipant(conversationId, userId);
  const [project] = await db
    .select()
    .from(taskProjects)
    .where(
      and(
        eq(taskProjects.id, projectId),
        eq(taskProjects.conversationId, conversationId),
      ),
    )
    .limit(1);
  if (!project) throw new ServiceError("Project not found", 404);

  const tasks = await db
    .select()
    .from(conversationThreads)
    .where(
      and(
        eq(conversationThreads.conversationId, conversationId),
        eq(conversationThreads.projectId, projectId),
      ),
    )
    .orderBy(
      desc(conversationThreads.lastActivityAt),
      desc(conversationThreads.id),
    )
    .limit(MAX_PROJECT_DETAIL_TASKS);

  return {
    project: toPublicTaskProject(project),
    tasks: tasks.map(toPublicConversationThread),
  };
}

export async function createTaskProject(
  conversationId: string,
  userId: string,
  input: { name: string },
): Promise<TaskProjectPublic> {
  const name = normalizeTaskProjectName(input.name);
  let project: typeof taskProjects.$inferSelect;
  try {
    project = await db.transaction(async (tx) => {
      requireHuman(await requireConversationMutationAccess(tx, conversationId, userId));
      const [created] = await tx
        .insert(taskProjects)
        .values({ conversationId, name, createdById: userId })
        .returning();
      return created!;
    });
  } catch (error) {
    throw duplicateNameError(error);
  }

  const publicProject = toPublicTaskProject(project);
  await publishToConversation(conversationId, {
    type: "task_project_updated",
    conversationId,
    project: publicProject,
  });
  return publicProject;
}

export async function renameTaskProject(
  conversationId: string,
  projectId: string,
  userId: string,
  input: { name: string },
): Promise<TaskProjectPublic> {
  const name = normalizeTaskProjectName(input.name);
  let project: typeof taskProjects.$inferSelect | undefined;
  try {
    project = await db.transaction(async (tx) => {
      requireHuman(await requireConversationMutationAccess(tx, conversationId, userId));
      const [updated] = await tx
        .update(taskProjects)
        .set({ name, updatedAt: new Date() })
        .where(
          and(
            eq(taskProjects.id, projectId),
            eq(taskProjects.conversationId, conversationId),
          ),
        )
        .returning();
      return updated;
    });
  } catch (error) {
    throw duplicateNameError(error);
  }
  if (!project) throw new ServiceError("Project not found", 404);

  const publicProject = toPublicTaskProject(project);
  await publishToConversation(conversationId, {
    type: "task_project_updated",
    conversationId,
    project: publicProject,
  });
  return publicProject;
}

/**
 * Deletes only the grouping. `ON DELETE SET NULL` moves the project's tasks
 * out of it in the same statement, so no task is ever lost with a project.
 */
export async function deleteTaskProject(
  conversationId: string,
  projectId: string,
  userId: string,
) {
  const deleted = await db.transaction(async (tx) => {
    requireHuman(await requireConversationMutationAccess(tx, conversationId, userId));
    const [row] = await tx
      .delete(taskProjects)
      .where(
        and(
          eq(taskProjects.id, projectId),
          eq(taskProjects.conversationId, conversationId),
        ),
      )
      .returning({ id: taskProjects.id });
    return row;
  });
  if (!deleted) throw new ServiceError("Project not found", 404);

  await publishToConversation(conversationId, {
    type: "task_project_deleted",
    conversationId,
    projectId,
  });
  return { ok: true as const, deletedProjectId: projectId };
}

export function normalizeTaskProjectName(name: string) {
  const normalized = name.trim().replace(/\s+/g, " ");
  if (!normalized) throw new ServiceError("Project name is required", 400);
  if (normalized.length > MAX_TASK_PROJECT_NAME_LENGTH) {
    throw new ServiceError(
      `Project names can be at most ${MAX_TASK_PROJECT_NAME_LENGTH} characters`,
      400,
    );
  }
  return normalized;
}

function duplicateNameError(error: unknown) {
  if (isUniqueViolation(error)) {
    return new ServiceError("A project with this name already exists", 409);
  }
  return error;
}
