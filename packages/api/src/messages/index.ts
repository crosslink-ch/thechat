import { Elysia } from "elysia";
import { z } from "zod";
import { resolveTokenToUser } from "../auth/middleware";
import { ServiceError } from "../services/errors";
import { getMessages, sendMessage } from "../services/messages";
import { setMessageReaction } from "../services/message-reactions";
import {
  setHttpResponseStatus,
  withHttpServerSpan,
} from "../observability";

const sendSchema = z.object({
  clientMessageId: z.string().min(1).max(255).optional(),
  content: z.string().max(100_000).default(""),
  threadId: z.string().uuid().nullable().optional(),
  attachmentIds: z.array(z.string().uuid()).max(25).default([]),
}).refine(
  (value) => value.content.trim().length > 0 || value.attachmentIds.length > 0,
  { message: "Message text or at least one attachment is required" },
);

function isTruthyQueryValue(value: unknown) {
  return value === "true" || value === "1" || value === true;
}

const reactionSchema = z.object({
  emoji: z.string().min(1).max(32),
  active: z.boolean(),
});

export const messageRoutes = new Elysia({ prefix: "/messages" })
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

  // Fetch messages (paginated)
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
              threadId: parsed.data.threadId ?? null,
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
