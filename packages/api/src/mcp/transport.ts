import { Elysia } from "elysia";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpAuthenticationResult } from "./auth";

interface McpRouteDependencies {
  authenticate: (context: {
    request: Request;
  }) => Promise<McpAuthenticationResult>;
  setupTools: (server: McpServer) => void;
}

function methodNotAllowed() {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    },
    { status: 405, headers: { Allow: "POST" } },
  );
}

/**
 * Build the MCP route with injectable authentication and tool registration so
 * the real HTTP transport can be exercised without database fixtures.
 */
export function createMcpRoutes({
  authenticate,
  setupTools,
}: McpRouteDependencies) {
  return new Elysia().all(
    "/mcp",
    async ({ request }) => {
      const authentication = await authenticate({ request });
      if (authentication.response) return authentication.response;

      // This endpoint is intentionally stateless request/response MCP. It has no
      // server-initiated notifications or resumable streams, so GET and DELETE
      // session operations are not exposed.
      if (request.method !== "POST") return methodNotAllowed();

      const server = new McpServer(
        { name: "thechat", version: "0.1.0" },
        { capabilities: { tools: {} } },
      );
      setupTools(server);

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      await server.connect(transport);
      try {
        return await transport.handleRequest(request, {
          authInfo: authentication.authInfo,
        });
      } finally {
        await server.close();
      }
    },
    // Authentication and the official transport must see the untouched request.
    // Otherwise Elysia turns malformed JSON into a plain 400 before either runs.
    { parse: "none" },
  );
}
