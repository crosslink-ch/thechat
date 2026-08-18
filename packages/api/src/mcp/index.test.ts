import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Elysia } from "elysia";
import { createMcpRoutes } from "./transport";
import type {
  McpAuthenticationResult,
  TheChatMcpAuthInfo,
} from "./auth";

const users = new Map([
  ["token-alice", { id: "user-alice", name: "Alice" }],
  ["token-bob", { id: "user-bob", name: "Bob" }],
]);

function authenticate({ request }: { request: Request }): Promise<McpAuthenticationResult> {
  const authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : undefined;
  const user = token ? users.get(token) : undefined;

  if (!token || !user) {
    return Promise.resolve({
      response: Response.json({ error: "Unauthorized" }, { status: 401 }),
    });
  }

  return Promise.resolve({
    authInfo: {
      ...user,
      email: `${user.id}@example.test`,
      avatar: null,
      type: "human",
      token,
      clientId: user.id,
      scopes: [],
    } as TheChatMcpAuthInfo,
  });
}

function setupTools(server: McpServer) {
  server.registerTool(
    "whoami",
    {
      description: "Return the authenticated test principal",
      inputSchema: {},
    },
    async (_args, extra) => {
      const authInfo = extra.authInfo as TheChatMcpAuthInfo | undefined;
      return {
        content: [
          {
            type: "text" as const,
            text: authInfo?.id ?? "missing",
          },
        ],
      };
    },
  );
}

// Compose the route into a parent app exactly as production does. This catches
// regressions where Elysia consumes the JSON body before the official transport.
const app = new Elysia().use(createMcpRoutes({ authenticate, setupTools }));

interface Exchange {
  method: string;
  status: number;
  contentType: string;
  body: string;
}

function createAppFetch(exchanges: Exchange[]) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const response = await app.handle(request);
    const body = await response.clone().text();

    exchanges.push({
      method: request.method,
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      body,
    });

    return response;
  };
}

async function runOfficialClient(token: string, exchanges: Exchange[]) {
  const client = new Client(
    { name: "thechat-transport-test", version: "1.0.0" },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL("http://localhost/mcp"),
    {
      requestInit: {
        headers: { authorization: `Bearer ${token}` },
      },
      fetch: createAppFetch(exchanges),
    },
  );

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const result = await client.callTool({ name: "whoami", arguments: {} });
    return { tools, result };
  } finally {
    await client.close();
  }
}

describe("official MCP Streamable HTTP transport", () => {
  test("rejects missing and invalid authentication before MCP handling", async () => {
    const missing = await app.handle(
      new Request("http://localhost/mcp", {
        method: "GET",
        headers: { accept: "text/event-stream" },
      }),
    );
    const invalid = await app.handle(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer invalid-token",
          "content-type": "application/json",
        },
        body: "{",
      }),
    );

    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "Unauthorized" });
    expect(invalid.status).toBe(401);
    expect(await invalid.json()).toEqual({ error: "Unauthorized" });
  });

  test("returns the official JSON-RPC parse error for malformed authorized JSON", async () => {
    const response = await app.handle(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer token-alice",
          "content-type": "application/json",
        },
        body: "{",
      }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error: Invalid JSON" },
      id: null,
    });
  });

  test("supports only stateless POST requests", async () => {
    const response = await app.handle(
      new Request("http://localhost/mcp", {
        method: "GET",
        headers: {
          accept: "text/event-stream",
          authorization: "Bearer token-alice",
        },
      }),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  test("initializes, discovers tools, calls a tool, and isolates concurrent clients", async () => {
    const aliceExchanges: Exchange[] = [];
    const bobExchanges: Exchange[] = [];

    const [alice, bob] = await Promise.all([
      runOfficialClient("token-alice", aliceExchanges),
      runOfficialClient("token-bob", bobExchanges),
    ]);

    expect(alice.tools.tools.map((tool) => tool.name)).toContain("whoami");
    expect(bob.tools.tools.map((tool) => tool.name)).toContain("whoami");
    expect(alice.result.content).toEqual([
      { type: "text", text: "user-alice" },
    ]);
    expect(bob.result.content).toEqual([
      { type: "text", text: "user-bob" },
    ]);

    for (const exchange of [...aliceExchanges, ...bobExchanges]) {
      expect(exchange.body).not.toContain("data: event: message");
      if (exchange.method === "GET") {
        // Official clients may probe for a server-initiated SSE stream. A
        // stateless request/response server explicitly declines it.
        expect(exchange.status).toBe(405);
        expect(exchange.contentType).toContain("application/json");
        continue;
      }

      expect(exchange.method).toBe("POST");
      expect(exchange.status === 200 || exchange.status === 202).toBe(true);
      if (exchange.status === 200) {
        expect(exchange.contentType).toContain("application/json");
      }
    }

    expect(aliceExchanges.some(({ method }) => method === "GET")).toBe(true);
    expect(bobExchanges.some(({ method }) => method === "GET")).toBe(true);
    expect(aliceExchanges.filter(({ status }) => status === 200)).toHaveLength(3);
    expect(bobExchanges.filter(({ status }) => status === 200)).toHaveLength(3);
    expect(aliceExchanges.filter(({ status }) => status === 202)).toHaveLength(1);
    expect(bobExchanges.filter(({ status }) => status === 202)).toHaveLength(1);
  });
});
