import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn((_event: string, _handler: unknown) => Promise.resolve(vi.fn())),
  logError: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("../log", () => ({
  error: mocks.logError,
  formatError: (error: unknown) => String(error),
  info: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("../core/skills", () => ({
  discoverSkills: vi.fn(() => Promise.resolve([])),
}));

type ToolsModule = typeof import("./tools");
let toolsModule: ToolsModule;

describe("tools MCP lifecycle", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.invoke.mockResolvedValue(undefined);
    toolsModule = await import("./tools");
  });

  it("registers listeners before one idempotent global initialization", async () => {
    const first = toolsModule.useToolsStore.getState().initializeMcp();
    const second = toolsModule.useToolsStore.getState().initializeMcp();

    await Promise.all([first, second]);

    expect(mocks.listen.mock.calls.map((call) => call[0])).toEqual([
      "mcp-tools-ready",
      "mcp-server-error",
    ]);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith("mcp_initialize");

    await toolsModule.useToolsStore.getState().initializeMcp();
    expect(mocks.invoke).toHaveBeenCalledOnce();
  });

  it("serializes account changes, clears auth clients, and removes their tools", async () => {
    type Resolve = (value: string[]) => void;
    const pending: Resolve[] = [];
    mocks.invoke.mockImplementation(
      () => new Promise<string[]>((resolve) => pending.push(resolve)),
    );

    const authTool = {
      name: "thechat__get_me",
      description: "auth tool",
      parameters: {},
      execute: vi.fn(),
    };
    const publicTool = {
      name: "public__clock",
      description: "public tool",
      parameters: {},
      execute: vi.fn(),
    };
    toolsModule.useToolsStore.setState({
      mcpTools: [authTool, publicTool],
      mcpServerStatus: {
        thechat: { state: "connected", toolCount: 1 },
        public: { state: "connected", toolCount: 1 },
      },
    });

    const userA = toolsModule.useToolsStore.getState().initializeAuthMcp("user-a-token");
    const userB = toolsModule.useToolsStore.getState().initializeAuthMcp("user-b-token");
    const logout = toolsModule.useToolsStore.getState().initializeAuthMcp(null);

    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "mcp_initialize_authed", {
      token: "user-a-token",
    });

    pending.shift()!([]);
    await userA;
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2));
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "mcp_initialize_authed", {
      token: "user-b-token",
    });

    pending.shift()!([]);
    await userB;
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(3));
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, "mcp_initialize_authed", {
      token: null,
    });

    pending.shift()!(["thechat"]);
    await logout;

    expect(toolsModule.useToolsStore.getState().mcpTools).toEqual([publicTool]);
    expect(toolsModule.useToolsStore.getState().mcpServerStatus).toEqual({
      public: { state: "connected", toolCount: 1 },
    });
  });
});
