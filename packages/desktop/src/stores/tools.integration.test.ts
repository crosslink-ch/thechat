/**
 * Integration test for session tool isolation via dynamic MCP loading.
 *
 * Verifies the core user scenario:
 *   1. Skill activates → MCP tools discovered from the real backend → added as session tools
 *   2. User starts a new chat → session tools are cleared
 *   3. New chat does NOT have the previously loaded tools
 *
 * Requires:
 *  - API server running on port 3000 (with PostgreSQL)
 *
 * Run:
 *   INTEGRATION=true pnpm --filter @thechat/desktop vitest run src/stores/tools.integration.test.ts
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { treaty } from "@elysiajs/eden";
import type { App } from "@thechat/api";
import { useToolsStore } from "./tools";
import type { McpToolInfo } from "../core/types";

const INTEGRATION = process.env.INTEGRATION === "true";

const API_URL = "http://localhost:3000";
const MCP_URL = `${API_URL}/mcp`;

const api = treaty<App>(API_URL);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function auth(token: string) {
  return { headers: { authorization: `Bearer ${token}` } };
}

let emailCounter = 0;
function uniqueEmail() {
  return `integ-tools-${Date.now()}-${++emailCounter}@test.com`;
}

const createdEmails: string[] = [];

async function registerUser(name: string) {
  const email = uniqueEmail();
  createdEmails.push(email);
  const { data, error } = await api.auth.register.post({
    name,
    email,
    password: "password123",
  });
  if (error) throw new Error("Registration failed");
  return { token: data.accessToken!, user: data.user! };
}

/**
 * Parse a response that may be JSON or SSE (text/event-stream).
 * MCP Streamable HTTP transport allows the server to respond with either format.
 */
async function parseMcpResponse(res: Response): Promise<Record<string, unknown>> {
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();

  if (contentType.includes("text/event-stream")) {
    // Parse SSE: extract JSON from "data: {..." lines
    // Format is: "data: event: message\ndata: {json}\n\n"
    const lines = text.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) {
        const data = trimmed.slice(5).trim();
        if (data.startsWith("{")) return JSON.parse(data);
      }
    }
    throw new Error(`No JSON data line found in SSE response: ${text}`);
  }

  return JSON.parse(text);
}

/**
 * Discover tools from the real MCP server via Streamable HTTP transport.
 * Sends JSON-RPC initialize + tools/list to /mcp.
 */
async function discoverMcpTools(token: string): Promise<McpToolInfo[]> {
  const mcpHeaders = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
  };

  // Initialize session
  const initRes = await fetch(MCP_URL, {
    method: "POST",
    headers: mcpHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "integration-test", version: "1.0.0" },
      },
      id: 1,
    }),
  });

  if (!initRes.ok) {
    throw new Error(`MCP initialize failed: ${initRes.status} ${await initRes.text()}`);
  }

  // Extract session ID from response header
  const sessionId = initRes.headers.get("mcp-session-id");

  // List tools
  const listHeaders: Record<string, string> = { ...mcpHeaders };
  if (sessionId) {
    listHeaders["mcp-session-id"] = sessionId;
  }

  const listRes = await fetch(MCP_URL, {
    method: "POST",
    headers: listHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/list",
      params: {},
      id: 2,
    }),
  });

  if (!listRes.ok) {
    throw new Error(`MCP tools/list failed: ${listRes.status} ${await listRes.text()}`);
  }

  const listBody = await parseMcpResponse(listRes);
  const tools = ((listBody.result as Record<string, unknown>)?.tools as unknown[]) ?? [];

  return tools.map((t: { name: string; description?: string; inputSchema?: Record<string, unknown> }) => ({
    server: "thechat",
    name: t.name,
    description: t.description ?? "",
    input_schema: t.inputSchema ?? {},
  }));
}

// ---------------------------------------------------------------------------
// Test suite — skipped unless INTEGRATION=true
// ---------------------------------------------------------------------------

describe.skipIf(!INTEGRATION)("Session tool isolation (integration)", () => {
  let user: { token: string; user: { id: string; name: string } };
  let mcpTools: McpToolInfo[];

  beforeAll(async () => {
    // Verify the API server is reachable
    try {
      await fetch(API_URL);
    } catch {
      throw new Error(
        `API server not reachable at ${API_URL}. Start it with: pnpm dev:api`,
      );
    }

    user = await registerUser("ToolTestUser");

    // Discover tools from the real MCP server
    mcpTools = await discoverMcpTools(user.token);
    expect(mcpTools.length).toBeGreaterThan(0);
  });

  afterAll(async () => {
    try {
      const { cleanupUserByEmail } = await import("@thechat/api/test-helpers");
      for (const email of createdEmails) {
        await cleanupUserByEmail(email);
      }
    } catch {
      // Cleanup requires DATABASE_URL; skip if unavailable (test users have unique emails)
    }
  });

  beforeEach(() => {
    // Reset store to a clean state before each test
    useToolsStore.setState({
      mcpTools: [],
      sessionMcpTools: [],
      skills: [],
    });
    // Recompute tools with empty state
    useToolsStore.getState().clearSessionMcpTools();
  });

  test("MCP server exposes expected tools", () => {
    // Verify the MCP server returned real tools (sanity check)
    const toolNames = mcpTools.map((t) => t.name);
    expect(toolNames).toContain("get_me");
    expect(toolNames).toContain("list_workspaces");
    expect(toolNames).toContain("send_message");
  });

  test("tools loaded via skill appear in session, then disappear on new chat", () => {
    const store = useToolsStore.getState();
    const initialToolCount = store.tools.length;
    const initialToolNames = new Set(store.tools.map((t) => t.name));

    // Verify no MCP tools are present initially
    expect(store.sessionMcpTools).toHaveLength(0);
    expect(store.mcpTools).toHaveLength(0);

    // --- Simulate: skill activates and loads MCP tools ---
    useToolsStore.getState().addSessionMcpTools(mcpTools);

    // Session tools should now be present
    const afterSkill = useToolsStore.getState();
    expect(afterSkill.sessionMcpTools.length).toBe(mcpTools.length);

    // Each MCP tool should be in the combined tools list with prefixed name
    for (const mcp of mcpTools) {
      const prefixed = `thechat__${mcp.name}`;
      const found = afterSkill.tools.find((t) => t.name === prefixed);
      expect(found, `Expected tool ${prefixed} to be available`).toBeDefined();
    }

    // Total tool count should have increased
    expect(afterSkill.tools.length).toBe(initialToolCount + mcpTools.length);

    // --- Simulate: user creates a new chat ---
    useToolsStore.getState().clearSessionMcpTools();

    // Session tools should be gone
    const afterNewChat = useToolsStore.getState();
    expect(afterNewChat.sessionMcpTools).toHaveLength(0);
    expect(afterNewChat.tools.length).toBe(initialToolCount);

    // No MCP tool names should remain
    for (const mcp of mcpTools) {
      const prefixed = `thechat__${mcp.name}`;
      expect(
        afterNewChat.tools.find((t) => t.name === prefixed),
        `Tool ${prefixed} should NOT be present after new chat`,
      ).toBeUndefined();
    }

    // Original builtin tools should still be present
    for (const name of initialToolNames) {
      expect(
        afterNewChat.tools.find((t) => t.name === name),
        `Builtin tool ${name} should still be present`,
      ).toBeDefined();
    }
  });

  test("getTools callback reflects session tool changes dynamically", () => {
    // This simulates how the chat loop uses getTools to get fresh tools each iteration
    const getTools = () => useToolsStore.getState().tools;

    // Before skill activation
    const toolsBefore = getTools();
    const hasAnyMcpTool = toolsBefore.some((t) => t.name.startsWith("thechat__"));
    expect(hasAnyMcpTool).toBe(false);

    // Activate skill → add session tools
    useToolsStore.getState().addSessionMcpTools(mcpTools);
    const toolsDuring = getTools();
    const mcpToolsDuring = toolsDuring.filter((t) => t.name.startsWith("thechat__"));
    expect(mcpToolsDuring.length).toBe(mcpTools.length);

    // New chat → clear session tools
    useToolsStore.getState().clearSessionMcpTools();
    const toolsAfter = getTools();
    const mcpToolsAfter = toolsAfter.filter((t) => t.name.startsWith("thechat__"));
    expect(mcpToolsAfter.length).toBe(0);
  });

  test("session tools do not leak into mcpTools (global)", () => {
    useToolsStore.getState().addSessionMcpTools(mcpTools);

    const state = useToolsStore.getState();
    // Session tools should be in sessionMcpTools, NOT in mcpTools
    expect(state.sessionMcpTools.length).toBeGreaterThan(0);
    expect(state.mcpTools).toHaveLength(0);
  });

  test("adding same tools twice deduplicates", () => {
    useToolsStore.getState().addSessionMcpTools(mcpTools);
    const countAfterFirst = useToolsStore.getState().sessionMcpTools.length;

    // Adding the same tools again should be a no-op
    useToolsStore.getState().addSessionMcpTools(mcpTools);
    const countAfterSecond = useToolsStore.getState().sessionMcpTools.length;

    expect(countAfterSecond).toBe(countAfterFirst);
  });
});
