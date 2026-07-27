import { Elysia } from "elysia";
import { z } from "zod";
import { resolveTokenToUser } from "../auth/middleware";
import { ServiceError } from "../services/errors";
import { setHttpResponseStatus, withHttpServerSpan } from "../observability";
import {
  completeAttachment,
  deleteAttachment,
  getAttachment,
  getAttachmentDownload,
  reserveAttachment,
} from "./service";

const reserveSchema = z.object({
  conversationId: z.string().uuid(),
  fileName: z.string().min(1).max(1024),
  mediaType: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive(),
  checksumSha256: z.string().min(1).max(128),
});

export const attachmentRoutes = new Elysia({ prefix: "/attachments" })
  .post("/", ({ body, headers, set }) =>
    tracedAuthenticatedRoute(
      "POST",
      "/attachments",
      headers,
      set,
      async (user) => {
        const parsed = reserveSchema.safeParse(body);
        if (!parsed.success) {
          set.status = 400;
          return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
        }
        return serviceResult(set, () =>
          reserveAttachment(user.id, parsed.data),
        );
      },
    ),
  )
  .post("/:id/complete", ({ headers, params, set }) =>
    tracedAuthenticatedRoute(
      "POST",
      "/attachments/:id/complete",
      headers,
      set,
      (user) =>
        serviceResult(set, () => completeAttachment(params.id, user.id)),
    ),
  )
  .get("/:id/download", ({ headers, params, query, set }) =>
    tracedAuthenticatedRoute(
      "GET",
      "/attachments/:id/download",
      headers,
      set,
      (user) =>
        serviceResult(set, () =>
          getAttachmentDownload(params.id, user.id, {
            disposition:
              query.disposition === "inline" ? "inline" : "attachment",
          }),
        ),
    ),
  )
  .get("/:id/content", ({ headers, params, query, set }) =>
    tracedAuthenticatedRoute(
      "GET",
      "/attachments/:id/content",
      headers,
      set,
      async (user) => {
        const result = await serviceResult(set, () =>
          getAttachmentDownload(params.id, user.id, {
            disposition: query.download === "1" ? "attachment" : "inline",
          }),
        );
        if ("error" in result) return result;
        return Response.redirect(result.url, 302);
      },
    ),
  )
  .get("/:id", ({ headers, params, set }) =>
    tracedAuthenticatedRoute("GET", "/attachments/:id", headers, set, (user) =>
      serviceResult(set, () => getAttachment(params.id, user.id)),
    ),
  )
  .delete("/:id", ({ headers, params, set }) =>
    tracedAuthenticatedRoute(
      "DELETE",
      "/attachments/:id",
      headers,
      set,
      (user) => serviceResult(set, () => deleteAttachment(params.id, user.id)),
    ),
  );

async function tracedAuthenticatedRoute<T>(
  method: string,
  route: string,
  headers: Record<string, string | string[] | undefined>,
  set: { status?: number | string },
  operation: (user: { id: string }) => Promise<T>,
): Promise<T | { error: string }> {
  return withHttpServerSpan(method, route, headers, async (span) => {
    const rawAuthorization = headers.authorization;
    const authHeader = Array.isArray(rawAuthorization)
      ? rawAuthorization[0]
      : rawAuthorization;
    const user = authHeader?.startsWith("Bearer ")
      ? await resolveTokenToUser(authHeader.slice(7))
      : null;
    if (!user) {
      set.status = 401;
      setHttpResponseStatus(span, set.status);
      return { error: "Authentication required" };
    }

    try {
      const result = await operation(user);
      setHttpResponseStatus(
        span,
        result instanceof Response ? result.status : set.status,
      );
      return result;
    } catch {
      set.status = 500;
      setHttpResponseStatus(span, set.status);
      return { error: "Internal server error" };
    }
  });
}

async function serviceResult<T>(
  set: { status?: number | string },
  operation: () => Promise<T>,
): Promise<T | { error: string }> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ServiceError) {
      set.status = error.status;
      return { error: error.message };
    }
    throw error;
  }
}
