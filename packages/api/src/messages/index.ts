import { Elysia } from "elysia";
import { z } from "zod";
import { resolveRequestUser } from "../auth/middleware";
import { browserAuthPolicy } from "../auth/browser";
import { ServiceError } from "../services/errors";
import {
  getMessages,
  getTaskMessagePage,
  getThreadPage,
  sendMessage,
  setThreadFollowing,
} from "../services/messages";
import { publishWsEventToUsers } from "../realtime";
import { setMessageReaction } from "../services/message-reactions";
import {
  setHttpResponseStatus,
  withHttpServerSpan,
} from "../observability";

const sendSchema = z.object({
  clientMessageId: z.string().min(1).max(255).optional(),
  content: z.string().max(100_000).default(""),
  threadId: z.string().uuid().nullable().optional(),
  /** Reply in this message's thread (Slack-style reply threads). */
  parentMessageId: z.string().uuid().nullable().optional(),
  /** Also show the reply in the conversation's main timeline. */
  alsoSendToConversation: z.boolean().optional(),
  attachmentIds: z.array(z.string().uuid()).max(25).default([]),
}).refine(
  (value) => value.content.trim().length > 0 || value.attachmentIds.length > 0,
  { message: "Message text or at least one attachment is required" },
);

function isTruthyQueryValue(value: unknown) {
  return value === "true" || value === "1" || value === true;
}

const threadPageQuerySchema = z.object({
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();

const followSchema = z.object({ following: z.boolean() }).strict();

function serviceErrorResponse(error: unknown, set: { status?: number | string }) {
  if (error instanceof ServiceError) {
    set.status = error.status;
    return { error: error.message };
  }
  throw error;
}

const reactionSchema = z.object({
  emoji: z.string().min(1).max(32),
  active: z.boolean(),
});

export const messageRoutes = new Elysia({ prefix: "/messages" })
  .use(browserAuthPolicy)
  .derive(async ({ headers }) => ({ user: await resolveRequestUser(headers) } as any))
  .onBeforeHandle(({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: "Authentication required" };
    }
  })

  .post(
    "/:conversationId/:messageId/reactions",
    async ({ params, body, user, set }) => {
      const parsed = reactionSchema.safeParse(body);
      if (!parsed.success) {
        set.status = 400;
        return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
      }
      try {
        return await setMessageReaction(
          params.conversationId,
          params.messageId,
          user.id,
          parsed.data.emoji,
          parsed.data.active,
        );
      } catch (error) {
        if (error instanceof ServiceError) {
          set.status = error.status;
          return { error: error.message };
        }
        throw error;
      }
    },
  )

  // One reply thread: its root, newest replies and follow state.
  .get("/:conversationId/threads/:rootMessageId", async ({ params, query, user, set }) => {
    const parsed = threadPageQuerySchema.safeParse(query);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    try {
      return await getThreadPage(params.conversationId, params.rootMessageId, user.id, {
        ...parsed.data,
        includeAttachments: user.type !== "bot" || user.attachmentAccess === true,
      });
    } catch (error) {
      return serviceErrorResponse(error, set);
    }
  })

  // Follow or unfollow a reply thread.
  .post("/:conversationId/threads/:rootMessageId/follow", async ({ params, body, user, set }) => {
    const parsed = followSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    try {
      const result = await setThreadFollowing(
        params.conversationId,
        params.rootMessageId,
        user.id,
        parsed.data.following,
      );
      // The user's other windows and devices update their follow toggle.
      await publishWsEventToUsers([user.id], {
        type: "thread_follow_updated",
        conversationId: params.conversationId,
        rootMessageId: params.rootMessageId,
        following: result.following,
      }).catch(() => {});
      return result;
    } catch (error) {
      return serviceErrorResponse(error, set);
    }
  })

  // Fetch messages (paginated)
  .get("/:conversationId/task-page", async ({ params, query, user, set }) => {
    const parsed = z.object({
      threadId: z.string().uuid().optional(),
      unthreaded: z.enum(["true", "1"]).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }).strict().refine((value) => Boolean(value.threadId) !== Boolean(value.unthreaded), {
      message: "Select one task or General",
    }).safeParse(query);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    try {
      return await getTaskMessagePage(params.conversationId, user.id, parsed.data.threadId ?? null, {
        limit: parsed.data.limit,
        includeAttachments: user.type !== "bot" || user.attachmentAccess === true,
      });
    } catch (error) {
      if (error instanceof ServiceError) {
        set.status = error.status;
        return { error: error.message };
      }
      throw error;
    }
  })

  // Ordinary clients and bots retain the array response and pagination contract.
  .get("/:conversationId", async ({ params, query, user, set }) => {
    try {
      return await getMessages(params.conversationId, user.id, {
        limit: Number(query.limit) || undefined,
        before: (query.before as string) || undefined,
        threadId: (query.threadId as string) || undefined,
        unthreaded: isTruthyQueryValue(query.unthreaded),
        includeAttachments:
          user.type !== "bot" || user.attachmentAccess === true,
      });
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  })

  // Send a message (REST fallback)
  .post("/:conversationId", ({ headers, params, body, user, set }) =>
    withHttpServerSpan(
      "POST",
      "/messages/:conversationId",
      headers,
      async (span) => {
        const parsed = sendSchema.safeParse(body);
        if (!parsed.success) {
          set.status = 400;
          setHttpResponseStatus(span, set.status);
          return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
        }

        try {
          const result = await sendMessage(
            params.conversationId,
            user.id,
            user.name,
            parsed.data.content,
            {
              threadId: parsed.data.parentMessageId
                ? parsed.data.threadId
                : (parsed.data.threadId ?? null),
              parentMessageId: parsed.data.parentMessageId ?? null,
              alsoSendToConversation: parsed.data.alsoSendToConversation,
              clientMessageId: parsed.data.clientMessageId,
              attachmentIds: parsed.data.attachmentIds,
            },
          );
          setHttpResponseStatus(span, set.status);
          return result;
        } catch (e) {
          if (e instanceof ServiceError) {
            set.status = e.status;
            setHttpResponseStatus(span, set.status);
            return { error: e.message };
          }
          set.status = 500;
          setHttpResponseStatus(span, set.status);
          return { error: "Internal server error" };
        }
      },
    ),
  );
