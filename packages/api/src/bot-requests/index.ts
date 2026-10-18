import { Elysia } from "elysia";
import { z } from "zod";
import { resolveRequestUser } from "../auth/middleware";
import { browserAuthPolicy } from "../auth/browser";
import { ServiceError } from "../services/errors";
import {
  acknowledgeBotRequest,
  answerBotRequest,
  BOT_REQUEST_KINDS,
  BOT_REQUEST_STATUSES,
  BotRequestConflictError,
  cancelBotRequest,
  createBotRequest,
  getBotRequestForActor,
  listBotRequestsForBot,
  listConversationBotRequests,
  listInbox,
  MAX_BOT_REQUEST_BODY_LENGTH,
  MAX_BOT_REQUEST_CHOICE_LENGTH,
  MAX_BOT_REQUEST_CHOICES,
  MAX_BOT_REQUEST_CLIENT_KEY_LENGTH,
  MAX_BOT_REQUEST_COMMENT_LENGTH,
  MAX_BOT_REQUEST_ORDER_GROUP_LENGTH,
  MAX_BOT_REQUEST_REASON_LENGTH,
  MAX_BOT_REQUEST_TEXT_LENGTH,
  MAX_BOT_REQUEST_TITLE_LENGTH,
  MAX_BOT_REQUEST_WAIT_SECONDS,
  waitForBotRequest,
} from "../services/bot-requests";

const responseSpecSchema = z
  .object({
    type: z.enum(["choice", "text"]),
    choices: z
      .array(z.string().max(MAX_BOT_REQUEST_CHOICE_LENGTH))
      .max(MAX_BOT_REQUEST_CHOICES)
      .optional(),
    labels: z.record(z.string(), z.string().max(100)).optional(),
    multiple: z.boolean().optional(),
    allowText: z.boolean().optional(),
    allowComment: z.boolean().optional(),
    maxLength: z.number().int().positive().max(MAX_BOT_REQUEST_TEXT_LENGTH).optional(),
  })
  .strict();

const createSchema = z
  .object({
    clientKey: z.string().trim().min(1).max(MAX_BOT_REQUEST_CLIENT_KEY_LENGTH),
    conversationId: z.string().uuid().nullish(),
    workspaceId: z.string().min(1).max(100).nullish(),
    threadId: z.string().uuid().nullish(),
    invocationId: z.string().uuid().nullish(),
    kind: z.enum(BOT_REQUEST_KINDS),
    title: z.string().trim().min(1).max(MAX_BOT_REQUEST_TITLE_LENGTH),
    body: z.string().max(MAX_BOT_REQUEST_BODY_LENGTH).nullish(),
    details: z.record(z.string(), z.unknown()).nullish(),
    response: responseSpecSchema.nullish(),
    orderGroup: z.string().max(MAX_BOT_REQUEST_ORDER_GROUP_LENGTH).nullish(),
    audienceUserId: z.string().uuid().nullish(),
    expiresAt: z.string().datetime({ offset: true }).nullish(),
  })
  .strict();

const cancelSchema = z
  .object({ reason: z.string().max(MAX_BOT_REQUEST_REASON_LENGTH).nullish() })
  .strict();

const ackSchema = z
  .object({
    applied: z.boolean(),
    note: z.string().max(MAX_BOT_REQUEST_REASON_LENGTH).nullish(),
  })
  .strict();

const answerSchema = z
  .object({
    choice: z.string().max(MAX_BOT_REQUEST_CHOICE_LENGTH).optional(),
    choices: z
      .array(z.string().max(MAX_BOT_REQUEST_CHOICE_LENGTH))
      .min(1)
      .max(MAX_BOT_REQUEST_CHOICES)
      .optional(),
    text: z.string().max(MAX_BOT_REQUEST_TEXT_LENGTH).optional(),
    comment: z.string().max(MAX_BOT_REQUEST_COMMENT_LENGTH).optional(),
  })
  .strict();

const statusesSchema = z.array(z.enum(BOT_REQUEST_STATUSES)).max(5);

type Actor = { id: string; type: "human" | "bot" };

function fail(set: { status?: unknown }, error: unknown) {
  if (error instanceof BotRequestConflictError) {
    set.status = 409;
    return { error: error.message, request: error.request };
  }
  set.status = error instanceof ServiceError ? error.status : 500;
  return {
    error: error instanceof ServiceError ? error.message : "Bot request operation failed",
  };
}

function invalid(set: { status?: unknown }, error: z.ZodError) {
  set.status = 400;
  const issue = error.issues[0];
  return {
    error: issue
      ? `${issue.path.join(".") || "body"}: ${issue.message}`
      : "Invalid input",
  };
}

const authenticated = new Elysia({ name: "bot-requests-auth" })
  .use(browserAuthPolicy)
  .derive(async ({ headers }) => ({
    actor: (await resolveRequestUser(headers)) as Actor | null,
  }))
  .onBeforeHandle(({ actor, set }) => {
    if (!actor) {
      set.status = 401;
      return { error: "Authentication required" };
    }
  })
  .as("scoped");

/**
 * Generic human-in-the-loop requests. Any bot token can create and track its
 * own requests; only human participants can read and answer them.
 */
export const botRequestRoutes = new Elysia({ prefix: "/bot-requests" })
  .use(authenticated)
  .post("/", async ({ body, actor, set }) => {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) return invalid(set, parsed.error);
    try {
      const { request, created } = await createBotRequest(actor!, {
        ...parsed.data,
        expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
      });
      set.status = created ? 201 : 200;
      return { request, created };
    } catch (error) {
      return fail(set, error);
    }
  })
  .get("/", async ({ query, actor, set }) => {
    const raw = typeof query.status === "string" ? query.status.split(",").filter(Boolean) : [];
    const statuses = statusesSchema.safeParse(raw);
    if (!statuses.success) return invalid(set, statuses.error);
    const limit = typeof query.limit === "string" ? Number.parseInt(query.limit, 10) : undefined;
    try {
      return {
        requests: await listBotRequestsForBot(actor!, {
          statuses: statuses.data,
          limit: Number.isFinite(limit) ? limit : undefined,
        }),
      };
    } catch (error) {
      return fail(set, error);
    }
  })
  .get("/conversations/:conversationId", async ({ params, actor, set }) => {
    try {
      return { requests: await listConversationBotRequests(actor!, params.conversationId) };
    } catch (error) {
      return fail(set, error);
    }
  })
  .get("/:requestId", async (context) => {
    const { params, query, actor, set, request } = context;
    const wait = typeof query.wait === "string" ? Number.parseInt(query.wait, 10) : 0;
    if (!Number.isFinite(wait) || wait < 0 || wait > MAX_BOT_REQUEST_WAIT_SECONDS) {
      set.status = 400;
      return { error: `wait must be 0-${MAX_BOT_REQUEST_WAIT_SECONDS} seconds` };
    }
    try {
      if (wait > 0) {
        // Bun closes idle connections after 10 s by default; a long-poll is
        // deliberately idle, so extend only this request's deadline.
        (context as { server?: { timeout?: (req: Request, seconds: number) => void } })
          .server?.timeout?.(request, wait + 15);
      }
      return {
        request: await waitForBotRequest(actor!, params.requestId, wait, request.signal),
      };
    } catch (error) {
      return fail(set, error);
    }
  })
  .post("/:requestId/cancel", async ({ params, body, actor, set }) => {
    const parsed = cancelSchema.safeParse(body ?? {});
    if (!parsed.success) return invalid(set, parsed.error);
    try {
      return {
        request: await cancelBotRequest(actor!, params.requestId, parsed.data.reason ?? null),
      };
    } catch (error) {
      return fail(set, error);
    }
  })
  .post("/:requestId/ack", async ({ params, body, actor, set }) => {
    const parsed = ackSchema.safeParse(body);
    if (!parsed.success) return invalid(set, parsed.error);
    try {
      return {
        request: await acknowledgeBotRequest(actor!, params.requestId, {
          applied: parsed.data.applied,
          note: parsed.data.note ?? null,
        }),
      };
    } catch (error) {
      return fail(set, error);
    }
  })
  .post("/:requestId/answer", async ({ params, body, actor, set }) => {
    const parsed = answerSchema.safeParse(body);
    if (!parsed.success) return invalid(set, parsed.error);
    try {
      return { request: await answerBotRequest(actor!, params.requestId, parsed.data) };
    } catch (error) {
      return fail(set, error);
    }
  });

/** Open requests for the signed-in person, plus recently resolved ones. */
export const inboxRoutes = new Elysia({ prefix: "/inbox" })
  .use(authenticated)
  .get("/", async ({ actor, set }) => {
    try {
      return await listInbox(actor!);
    } catch (error) {
      return fail(set, error);
    }
  });

export { getBotRequestForActor };
