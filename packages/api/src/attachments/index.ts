import { Elysia } from "elysia";
import { z } from "zod";
import { resolveTokenToUser } from "../auth/middleware";
import { ServiceError } from "../services/errors";
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
  .derive(async ({ headers }) => {
    const authHeader = headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return { user: null } as any;
    }
    const user = await resolveTokenToUser(authHeader.slice(7));
    if (!user) return { user: null } as any;
    return { user };
  })
  .onBeforeHandle(({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: "Authentication required" };
    }
  })
  .post("/", async ({ body, user, set }) => {
    const parsed = reserveSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    return serviceResult(set, () => reserveAttachment(user.id, parsed.data));
  })
  .post("/:id/complete", ({ params, user, set }) =>
    serviceResult(set, () => completeAttachment(params.id, user.id)),
  )
  .get("/:id/download", ({ params, query, user, set }) =>
    serviceResult(set, () =>
      getAttachmentDownload(params.id, user.id, {
        disposition: query.disposition === "inline" ? "inline" : "attachment",
      }),
    ),
  )
  .get("/:id/content", async ({ params, query, user, set }) => {
    const result = await serviceResult(set, () =>
      getAttachmentDownload(params.id, user.id, {
        disposition: query.download === "1" ? "attachment" : "inline",
      }),
    );
    if ("error" in result) return result;
    return Response.redirect(result.url, 302);
  })
  .get("/:id", ({ params, user, set }) =>
    serviceResult(set, () => getAttachment(params.id, user.id)),
  )
  .delete("/:id", ({ params, user, set }) =>
    serviceResult(set, () => deleteAttachment(params.id, user.id)),
  );

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
