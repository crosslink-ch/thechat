/**
 * Integration test for per-conversation session tool persistence.
 *
 * Verifies the core user scenario:
 *   1. Skill activates in Chat A → MCP tools added to conv-a's session
 *   2. User switches to Chat B → conv-a's tools disappear, conv-b has none
 *   3. User returns to Chat A → conv-a's tools are restored
 *   4. New chat (null) → no session tools
 *   5. Persistence: kv_set is called with correct key
 *
 * Requires:
 *  - API server running on port 3000 (with PostgreSQL)
 *
 * Run:
 *   INTEGRATION=true pnpm --filter @thechat/desktop vitest run src/stores/tools.integration.test.ts
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
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

  return (tools as { name: string; description?: string; inputSchema?: Record<string, unknown> }[]).map((t) => ({
    server: "thechat",
    name: t.name,
    description: t.description ?? "",
    input_schema: t.inputSchema ?? {},
  }));
}

// ---------------------------------------------------------------------------
// Test suite — skipped unless INTEGRATION=true
// ---------------------------------------------------------------------------

describe.skipIf(!INTEGRATION)("Per-conversation session tool persistence (integration)", () => {
  let user: { token: string; user: { id: string; name: string } };
  let mcpTools: McpToolInfo[];

  // Track kv_store calls
  const kvStore: Record<string, string> = {};
  const kvSetCalls: { key: string; value: string }[] = [];

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

  beforeEach(async () => {
    // Clear tracking
    Object.keys(kvStore).forEach((k) => delete kvStore[k]);
    kvSetCalls.length = 0;

    // Mock Tauri IPC for kv_get, kv_set, and mcp_initialize_servers
    mockIPC((cmd, args) => {
      if (cmd === "kv_get") {
        const key = (args as { key: string }).key;
        return kvStore[key] ?? null;
      }
      if (cmd === "kv_set") {
        const { key, value } = args as { key: string; value: string };
        kvStore[key] = value;
        kvSetCalls.push({ key, value });
        return null;
      }
      if (cmd === "mcp_initialize_servers") {
        return [];
      }
      return null;
    });

    // Reset store to a clean state (including recomputed tools)
    useToolsStore.setState({
      mcpTools: [],
      sessionToolsByConv: {},
      activeConvId: null,
      skills: [],
    });
    // Recompute tools by switching to null conversation
    await useToolsStore.getState().setActiveConversation(null);
  });

  test("MCP server exposes expected tools", () => {
    // Verify the MCP server returned real tools (sanity check)
    const toolNames = mcpTools.map((t) => t.name);
    expect(toolNames).toContain("get_me");
    expect(toolNames).toContain("list_workspaces");
    expect(toolNames).toContain("send_message");
  });

  test("tools loaded in conv-a are isolated from conv-b", async () => {
    const initialToolCount = useToolsStore.getState().tools.length;

    // Set active conversation to conv-a
    await useToolsStore.getState().setActiveConversation("conv-a");

    // Simulate: skill activates and loads MCP tools in conv-a
    useToolsStore.getState().addSessionMcpTools("conv-a", mcpTools);

    // Session tools should be present
    const afterSkill = useToolsStore.getState();
    expect(afterSkill.tools.length).toBe(initialToolCount + mcpTools.length);
    for (const mcp of mcpTools) {
      const prefixed = `thechat__${mcp.name}`;
      expect(afterSkill.tools.find((t) => t.name === prefixed)).toBeDefined();
    }

    // Switch to conv-b — should have NO session tools
    await useToolsStore.getState().setActiveConversation("conv-b");
    const afterSwitch = useToolsStore.getState();
    expect(afterSwitch.tools.length).toBe(initialToolCount);
    for (const mcp of mcpTools) {
      const prefixed = `thechat__${mcp.name}`;
      expect(afterSwitch.tools.find((t) => t.name === prefixed)).toBeUndefined();
    }

    // Return to conv-a — tools restored from in-memory cache
    await useToolsStore.getState().setActiveConversation("conv-a");
    const afterReturn = useToolsStore.getState();
    expect(afterReturn.tools.length).toBe(initialToolCount + mcpTools.length);
    for (const mcp of mcpTools) {
      const prefixed = `thechat__${mcp.name}`;
      expect(afterReturn.tools.find((t) => t.name === prefixed)).toBeDefined();
    }
  });

  test("new chat (null) clears session tools", async () => {
    const initialToolCount = useToolsStore.getState().tools.length;

    await useToolsStore.getState().setActiveConversation("conv-a");
    useToolsStore.getState().addSessionMcpTools("conv-a", mcpTools);
    expect(useToolsStore.getState().tools.length).toBe(initialToolCount + mcpTools.length);

    // Start new chat
    await useToolsStore.getState().setActiveConversation(null);
    expect(useToolsStore.getState().tools.length).toBe(initialToolCount);
    expect(useToolsStore.getState().activeConvId).toBeNull();
  });

  test("kv_set is called with correct key when adding session tools", async () => {
    await useToolsStore.getState().setActiveConversation("conv-persist");
    useToolsStore.getState().addSessionMcpTools("conv-persist", mcpTools);

    // Wait a tick for the fire-and-forget kv_set to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(kvSetCalls.length).toBeGreaterThan(0);
    const call = kvSetCalls.find((c) => c.key === "session_tools:conv-persist");
    expect(call).toBeDefined();

    const stored = JSON.parse(call!.value) as McpToolInfo[];
    expect(stored.length).toBe(mcpTools.length);
    expect(stored[0].server).toBe("thechat");
  });

  test("tools loaded from kv_store on setActiveConversation", async () => {
    const initialToolCount = useToolsStore.getState().tools.length;

    // Pre-populate kv_store (simulating app restart)
    kvStore["session_tools:conv-restored"] = JSON.stringify(mcpTools);

    // Switch to the conversation — should load from kv_store
    await useToolsStore.getState().setActiveConversation("conv-restored");

    const state = useToolsStore.getState();
    expect(state.tools.length).toBe(initialToolCount + mcpTools.length);
    expect(state.sessionToolsByConv["conv-restored"]?.length).toBe(mcpTools.length);
  });

  test("getTools callback reflects session tool changes dynamically", async () => {
    const getTools = () => useToolsStore.getState().tools;

    // Before skill activation
    const toolsBefore = getTools();
    expect(toolsBefore.some((t) => t.name.startsWith("thechat__"))).toBe(false);

    // Activate skill in conv-a
    await useToolsStore.getState().setActiveConversation("conv-a");
    useToolsStore.getState().addSessionMcpTools("conv-a", mcpTools);
    const toolsDuring = getTools();
    expect(toolsDuring.filter((t) => t.name.startsWith("thechat__")).length).toBe(mcpTools.length);

    // Switch to conv-b (no tools)
    await useToolsStore.getState().setActiveConversation("conv-b");
    const toolsAfter = getTools();
    expect(toolsAfter.filter((t) => t.name.startsWith("thechat__")).length).toBe(0);
  });

  test("session tools do not leak into mcpTools (global)", async () => {
    await useToolsStore.getState().setActiveConversation("conv-a");
    useToolsStore.getState().addSessionMcpTools("conv-a", mcpTools);

    const state = useToolsStore.getState();
    expect(state.sessionToolsByConv["conv-a"]!.length).toBeGreaterThan(0);
    expect(state.mcpTools).toHaveLength(0);
  });

  test("adding same tools twice deduplicates", async () => {
    await useToolsStore.getState().setActiveConversation("conv-a");
    useToolsStore.getState().addSessionMcpTools("conv-a", mcpTools);
    const countAfterFirst = useToolsStore.getState().sessionToolsByConv["conv-a"]!.length;

    // Adding the same tools again should be a no-op
    useToolsStore.getState().addSessionMcpTools("conv-a", mcpTools);
    const countAfterSecond = useToolsStore.getState().sessionToolsByConv["conv-a"]!.length;

    expect(countAfterSecond).toBe(countAfterFirst);
  });
});
