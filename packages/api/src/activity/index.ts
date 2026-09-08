import { Elysia } from "elysia";
import { z } from "zod";
import { resolveRequestUser } from "../auth/middleware";
import { browserAuthPolicy } from "../auth/browser";
import {
  listActivity,
  markAllActivityRead,
  markConversationRead,
} from "../services/activity";
import { ServiceError } from "../services/errors";

const renderedMessageIdsSchema = z
  .array(z.string().uuid())
  .min(1)
  .max(200)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "Rendered message IDs must be unique",
  });

const readSelectionSchema = z.union([
  z.object({ messageIds: renderedMessageIdsSchema }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);

export const activityRoutes = new Elysia({ prefix: "/activity" })
  .use(browserAuthPolicy)
  .derive(async ({ headers }) => ({ user: await resolveRequestUser(headers) } as any))
  .onBeforeHandle(({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: "Authentication required" };
    }
  })
  .get("/", async ({ user }) => listActivity(user.id))
  .post(
    "/conversations/:conversationId/read",
    async ({ params, body, user, set }) => {
      const parsed = readSelectionSchema.safeParse(body);
      if (!parsed.success) {
        set.status = 400;
        return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
      }

      try {
        return await markConversationRead(
          params.conversationId,
          user.id,
          parsed.data,
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
  .post("/read-all", async ({ user }) => markAllActivityRead(user.id));
