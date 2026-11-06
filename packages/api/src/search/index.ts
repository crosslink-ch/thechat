import { Elysia } from "elysia";
import { z } from "zod";
import { resolveRequestUser } from "../auth/middleware";
import { browserAuthPolicy } from "../auth/browser";
import { ServiceError } from "../services/errors";
import {
  findDestinations,
  getMessageContext,
  getSearchDirectory,
  MESSAGE_CONTEXT_MAX,
  MESSAGE_SEARCH_MAX_LIMIT,
  searchMessages,
} from "../services/search";

const optionalText = z.string().trim().min(1).optional();

const messageSearchQuery = z
  .object({
    q: z.string().max(500),
    workspaceId: optionalText,
    conversationId: z.string().uuid().optional(),
    threadId: z.string().uuid().optional(),
    senderId: z.string().uuid().optional(),
    after: optionalText,
    before: optionalText,
    cursor: z.string().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(MESSAGE_SEARCH_MAX_LIMIT).optional(),
  })
  .strict();

const directoryQuery = z.object({ workspaceId: optionalText }).strict();

const destinationKinds = z.enum(["channel", "person", "task"]);
const destinationsQuery = z
  .object({
    q: z.string().trim().min(1).max(200),
    kinds: z
      .string()
      .optional()
      .transform((value, context) => {
        if (!value) return undefined;
        const parsed = z.array(destinationKinds).safeParse(value.split(",").map((kind) => kind.trim()));
        if (!parsed.success) {
          context.addIssue({ code: "custom", message: "kinds must list channel, person or task" });
          return z.NEVER;
        }
        return parsed.data;
      }),
    workspaceId: optionalText,
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();

const contextQuery = z
  .object({
    before: z.coerce.number().int().min(0).max(MESSAGE_CONTEXT_MAX).optional(),
    after: z.coerce.number().int().min(0).max(MESSAGE_CONTEXT_MAX).optional(),
  })
  .strict();

function invalid(set: { status?: number | string }, error: z.ZodError) {
  set.status = 400;
  return { error: error.issues[0]?.message ?? "Invalid input" };
}

async function service<T>(set: { status?: number | string }, run: () => Promise<T>) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ServiceError) {
      set.status = error.status;
      return { error: error.message };
    }
    throw error;
  }
}

/**
 * Search for people, bots and agents alike. Every endpoint returns only what
 * the caller can read: conversations they take part in, in workspaces they
 * still belong to. See docs/search.md.
 */
export const searchRoutes = new Elysia({ prefix: "/search" })
  .use(browserAuthPolicy)
  .derive(async ({ headers }) => ({ user: await resolveRequestUser(headers) } as any))
  .onBeforeHandle(({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: "Authentication required" };
    }
  })

  .get("/messages", async ({ query, user, set }) => {
    const parsed = messageSearchQuery.safeParse(query);
    if (!parsed.success) return invalid(set, parsed.error);
    return service(set, () =>
      searchMessages(user.id, { ...parsed.data, query: parsed.data.q }),
    );
  })

  .get("/directory", async ({ query, user, set }) => {
    const parsed = directoryQuery.safeParse(query);
    if (!parsed.success) return invalid(set, parsed.error);
    return service(set, async () => ({
      destinations: await getSearchDirectory(user.id, parsed.data),
    }));
  })

  .get("/destinations", async ({ query, user, set }) => {
    const parsed = destinationsQuery.safeParse(query);
    if (!parsed.success) return invalid(set, parsed.error);
    return service(set, async () => ({
      destinations: await findDestinations(user.id, parsed.data.q, parsed.data),
    }));
  })

  .get("/messages/:messageId/context", async ({ params, query, user, set }) => {
    if (!z.string().uuid().safeParse(params.messageId).success) {
      set.status = 404;
      return { error: "Message not found" };
    }
    const parsed = contextQuery.safeParse(query);
    if (!parsed.success) return invalid(set, parsed.error);
    return service(set, () => getMessageContext(user.id, params.messageId, parsed.data));
  });
