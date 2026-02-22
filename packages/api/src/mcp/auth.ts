import { resolveTokenToUser } from "../auth/middleware";

export type McpUser = NonNullable<
  Awaited<ReturnType<typeof resolveTokenToUser>>
>;

/**
 * MCP authentication callback for elysia-mcp plugin.
 * Receives the full Elysia context, extracts Bearer token,
 * resolves to user, and returns authInfo for tool handlers.
 */
export async function mcpAuthenticate(context: {
  request: Request;
}): Promise<{ authInfo?: McpUser; response?: Response }> {
  const authHeader = context.request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return {
      response: Response.json(
        { error: "Authentication required" },
        { status: 401 }
      ),
    };
  }

  const token = authHeader.slice(7);
  const user = await resolveTokenToUser(token);

  if (!user) {
    return {
      response: Response.json({ error: "Invalid token" }, { status: 401 }),
    };
  }

  return { authInfo: user };
}
