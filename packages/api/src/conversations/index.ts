import { Elysia } from "elysia";
import { z } from "zod";
import { resolveRequestUser } from "../auth/middleware";
import { browserAuthPolicy } from "../auth/browser";
import { ServiceError } from "../services/errors";
import {
  createConversationThread,
  createOrGetDm,
  getConversationDetail,
  listConversationThreads,
  listUserDms,
  createChannel,
  deleteChannel,
  deleteConversationThread,
  renameChannel,
  updateConversationThread,
} from "../services/conversations";
import {
  createTaskProject,
  deleteTaskProject,
  getTaskProject,
  listTaskProjects,
  MAX_TASK_PROJECT_NAME_LENGTH,
  renameTaskProject,
} from "../services/task-projects";

const dmSchema = z.object({
  workspaceId: z.string().trim().min(1),
  otherUserId: z.string().uuid(),
});

const channelSchema = z.object({
  workspaceId: z.string().trim().min(1),
  name: z.string().trim().min(1).max(100),
});

const threadSchema = z.object({
  botId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(255).optional(),
  // Present (including null) means "create this task as a Hermes branch".
  // Null branches from the conversation's general Hermes lane; a UUID branches
  // from that TheChat task thread. Hermes resolves the actual session at run time.
  branchFromThreadId: z.string().uuid().nullable().optional(),
  // Files the new task under a project; null or absent leaves it unfiled
  // (a branch inherits its source task's project when this is absent).
  projectId: z.string().uuid().nullable().optional(),
});

const updateThreadSchema = z
  .object({
    threadId: z.string().uuid(),
    title: z.string().trim().min(1).max(255).optional(),
    // null moves the task out of its project.
    projectId: z.string().uuid().nullable().optional(),
  })
  .refine(
    (value) => value.title !== undefined || value.projectId !== undefined,
    { message: "Provide a title or projectId to update" },
  );

const projectSchema = z.object({
  name: z.string().trim().min(1).max(MAX_TASK_PROJECT_NAME_LENGTH),
});

const threadListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
  cursor: z.string().min(1).optional(),
  botId: z.string().uuid().optional(),
  status: z.string().trim().min(1).max(20).optional(),
});

export const conversationRoutes = new Elysia({ prefix: "/conversations" })
  .use(browserAuthPolicy)
  .derive(async ({ headers }) => ({ user: await resolveRequestUser(headers) } as any))
  .onBeforeHandle(({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: "Authentication required" };
    }
  })

  // Get a conversation and its participants
  .get("/detail/:conversationId", async ({ params, user, set }) => {
    try {
      return await getConversationDetail(params.conversationId, user.id);
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  })

  // Create or get existing DM between two users in a workspace
  .post("/dm", async ({ body, user, set }) => {
    const parsed = dmSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    try {
      return await createOrGetDm(
        parsed.data.workspaceId,
        user.id,
        parsed.data.otherUserId
      );
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  })

  // Create a new channel
  .post("/channel", async ({ body, user, set }) => {
    const parsed = channelSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    try {
      return await createChannel(
        parsed.data.workspaceId,
        parsed.data.name,
        user.id
      );
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  })

  // Rename a channel. Channel-wide mutations are limited to workspace managers.
  .patch("/channel/:conversationId", async ({ params, body, user, set }) => {
    const parsed = channelSchema.pick({ name: true }).safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    try {
      return await renameChannel(
        params.conversationId,
        parsed.data.name,
        user.id,
      );
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  })

  // Permanently delete a channel and its message history.
  .delete("/channel/:conversationId", async ({ params, user, set }) => {
    try {
      return await deleteChannel(params.conversationId, user.id);
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  })

  // List task threads for a conversation
  .get("/threads/:conversationId", async ({ params, query, user, set }) => {
    const parsed = threadListQuerySchema.safeParse(query);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid query" };
    }

    try {
      return await listConversationThreads(
        params.conversationId,
        user.id,
        {
          limit: parsed.data.limit,
          cursor: parsed.data.cursor,
          botId: parsed.data.botId,
          status: parsed.data.status,
        },
      );
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  })

  // Create a task thread for a Hermes-capable conversation
  .post("/threads/:conversationId", async ({ params, body, user, set }) => {
    const parsed = threadSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    try {
      return await createConversationThread(
        params.conversationId,
        user.id,
        parsed.data,
      );
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  })

  .patch("/threads/:conversationId", async ({ params, body, user, set }) => {
    const parsed = updateThreadSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    try {
      return await updateConversationThread(
        params.conversationId,
        parsed.data.threadId,
        user.id,
        { title: parsed.data.title, projectId: parsed.data.projectId },
      );
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  })

  // Permanently delete a task with its messages, bot requests and files.
  .delete(
    "/threads/:conversationId/:threadId",
    async ({ params, user, set }) =>
      handleServiceErrors(set, () =>
        deleteConversationThread(params.conversationId, params.threadId, user.id),
      ),
  )

  // Task projects: named groups of tasks inside one conversation.
  .get("/projects/:conversationId", async ({ params, user, set }) =>
    handleServiceErrors(set, () =>
      listTaskProjects(params.conversationId, user.id),
    ),
  )

  .get("/projects/:conversationId/:projectId", async ({ params, user, set }) =>
    handleServiceErrors(set, () =>
      getTaskProject(params.conversationId, params.projectId, user.id),
    ),
  )

  .post("/projects/:conversationId", async ({ params, body, user, set }) => {
    const parsed = projectSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    return handleServiceErrors(set, () =>
      createTaskProject(params.conversationId, user.id, parsed.data),
    );
  })

  .patch(
    "/projects/:conversationId/:projectId",
    async ({ params, body, user, set }) => {
      const parsed = projectSchema.safeParse(body);
      if (!parsed.success) {
        set.status = 400;
        return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
      }
      return handleServiceErrors(set, () =>
        renameTaskProject(
          params.conversationId,
          params.projectId,
          user.id,
          parsed.data,
        ),
      );
    },
  )

  // Deletes the project only; its tasks move back to "No project".
  .delete(
    "/projects/:conversationId/:projectId",
    async ({ params, user, set }) =>
      handleServiceErrors(set, () =>
        deleteTaskProject(params.conversationId, params.projectId, user.id),
      ),
  )

  // List DM conversations for current user in a workspace
  .get("/:workspaceId/dms", async ({ params, user, set }) => {
    try {
      return await listUserDms(params.workspaceId, user.id);
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  });

async function handleServiceErrors<T>(
  set: { status?: number | string },
  run: () => Promise<T>,
): Promise<T | { error: string }> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof ServiceError) {
      set.status = e.status;
      return { error: e.message };
    }
    throw e;
  }
}
