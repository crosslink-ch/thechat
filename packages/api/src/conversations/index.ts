import { Elysia } from "elysia";
import { z } from "zod";
import { resolveTokenToUser } from "../auth/middleware";
import { ServiceError } from "../services/errors";
import {
  createConversationThread,
  createOrGetDm,
  getConversationDetail,
  listConversationThreads,
  listUserDms,
  createChannel,
  updateConversationThread,
} from "../services/conversations";

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
});

const updateThreadSchema = z.object({
  threadId: z.string().uuid(),
  title: z.string().trim().min(1).max(255),
});

const threadListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
  cursor: z.string().min(1).optional(),
  botId: z.string().uuid().optional(),
  status: z.string().trim().min(1).max(20).optional(),
});

export const conversationRoutes = new Elysia({ prefix: "/conversations" })
  .derive(async ({ headers }) => {
    const authHeader = headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return { user: null } as any;
    }

    const token = authHeader.slice(7);
    const user = await resolveTokenToUser(token);
    if (!user) return { user: null } as any;
    return { user };
  })
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
        { title: parsed.data.title },
      );
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  })

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
