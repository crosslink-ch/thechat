import { Elysia } from "elysia";
import { z } from "zod";
import { resolveTokenToUser } from "../auth/middleware";
import { ServiceError } from "../services/errors";
import {
  listUserWorkspaces,
  getWorkspaceDetail,
  createWorkspace,
  joinWorkspace,
} from "../services/workspaces";

const createSchema = z.object({
  name: z.string().trim().min(1, "Workspace name is required"),
});

const joinSchema = z.object({
  workspaceId: z.string().trim().min(1, "Workspace ID is required"),
});

export const workspaceRoutes = new Elysia({ prefix: "/workspaces" })
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

  // Create workspace
  .post("/create", async ({ body, user, set }) => {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    try {
      return await createWorkspace(parsed.data.name, user.id);
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  })

  // Join workspace
  .post("/join", async ({ body, user, set }) => {
    const parsed = joinSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    try {
      return await joinWorkspace(parsed.data.workspaceId, user.id);
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  })

  // List my workspaces
  .get("/list", async ({ user }) => {
    return await listUserWorkspaces(user.id);
  })

  // Get workspace detail
  .get("/:id", async ({ params, user, set }) => {
    try {
      return await getWorkspaceDetail(params.id, user.id);
    } catch (e) {
      if (e instanceof ServiceError) {
        set.status = e.status;
        return { error: e.message };
      }
      throw e;
    }
  });
