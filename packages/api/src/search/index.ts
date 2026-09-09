import { SEARCH_RESULT_CAP } from "@thechat/shared";
import { Elysia } from "elysia";
import { z } from "zod";
import { ServiceError } from "../services/errors";
import { browserAuthPolicy } from "../auth/browser";
import { resolveRequestUser } from "../auth/middleware";
import { searchJump, searchMessages, searchMessageContext } from "../services/search";

const queryText = z.string().max(200).regex(/^[^\u0000-\u001f\u007f]*$/).transform(value => value.trim());
const integerQuery = (minimum: number, maximum: number) => z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(minimum).max(maximum));
const recentIdsQuery = z.string().max(1600).refine(value => {
  if (value === "") return true;
  const ids = value.split(",");
  return ids.length <= 30 && new Set(ids).size === ids.length && ids.every(id => {
    const [kind, uuid, extra] = id.split(":");
    return extra === undefined && ["dm", "channel", "task"].includes(kind)
      && z.string().uuid().safeParse(uuid).success;
  });
});
const jumpQuery = z.object({
  q: queryText.default(""),
  kind: z.enum(["all", "dm", "channel", "task"]).default("all"),
  recentIds: recentIdsQuery.optional(),
  workspaceId: z.string().min(1).max(100).regex(/^[^\u0000-\u001f\u007f]+$/).optional(),
  limit: integerQuery(1, 50).default(30),
  offset: integerQuery(0, SEARCH_RESULT_CAP).default(0),
}).strict();
const messageQuery = z.object({
  q: queryText.pipe(z.string().min(1)),
  limit: integerQuery(1, 50).default(20),
  offset: integerQuery(0, SEARCH_RESULT_CAP).default(0),
}).strict();
function hasDuplicateQuery(request: Request) {
  const keys = [...new URL(request.url).searchParams.keys()];
  return keys.length !== new Set(keys).size;
}

export const searchRoutes = new Elysia({ prefix: "/search" })
  .use(browserAuthPolicy)
  .derive(async ({ headers }) => ({ user: await resolveRequestUser(headers) }))
  .onBeforeHandle(({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: "Authentication required" };
    }
    if (user.type !== "human") {
      set.status = 403;
      return { error: "Search is available to human users only" };
    }
  })
  .get("/jump", ({ user, query, request, set }) => {
    const parsed = jumpQuery.safeParse(query);
    if (!parsed.success || hasDuplicateQuery(request)) {
      set.status = 400;
      return { error: "Invalid search query" };
    }
    return searchJump(user!.id, parsed.data);
  })
  .get("/messages", ({ user, query, request, set }) => {
    const parsed = messageQuery.safeParse(query);
    if (!parsed.success || hasDuplicateQuery(request)) {
      set.status = 400;
      return { error: "Invalid search query" };
    }
    return searchMessages(user!.id, parsed.data.q, parsed.data.limit, parsed.data.offset);
  })
  .get("/messages/:messageId/context", async ({ user, params, set }) => {
    if (!z.string().uuid().safeParse(params.messageId).success) {
      set.status = 404;
      return { error: "Message not found" };
    }
    try {
      return await searchMessageContext(user!.id, params.messageId);
    } catch (error) {
      if (error instanceof ServiceError) {
        set.status = error.status;
        return { error: error.message };
      }
      throw error;
    }
  });
