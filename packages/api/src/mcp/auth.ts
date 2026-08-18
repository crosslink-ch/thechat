import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { resolveTokenToUser } from "../auth/middleware";

export type McpUser = NonNullable<
  Awaited<ReturnType<typeof resolveTokenToUser>>
>;

/**
 * The official MCP transport requires the standard AuthInfo fields. TheChat's
 * existing tools also read the authenticated user directly from authInfo, so
 * this intersection preserves that request-scoped contract.
 */
export type TheChatMcpAuthInfo = AuthInfo & McpUser;

export type McpAuthenticationResult =
  | { authInfo: TheChatMcpAuthInfo; response?: never }
  | { authInfo?: never; response: Response };

/**
 * Authenticate one MCP HTTP request and attach the resolved TheChat user to the
 * official SDK's request-scoped authInfo.
 */
export async function mcpAuthenticate(context: {
  request: Request;
}): Promise<McpAuthenticationResult> {
  const authHeader = context.request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return {
      response: Response.json(
        { error: "Authentication required" },
        { status: 401 },
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

  return {
    authInfo: {
      ...user,
      token,
      // TheChat bearer credentials are principal-bound rather than OAuth
      // client-bound, so use the authenticated principal as the stable ID.
      clientId: user.id,
      scopes: [],
    },
  };
}
