import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activateMcp: vi.fn(() => Promise.resolve()),
  checkForUpdates: vi.fn(),
  discoverSkills: vi.fn(),
  fetchConversations: vi.fn(),
  initializeAuth: vi.fn(),
  initializeAuthMcp: vi.fn(() => Promise.resolve()),
  initializeCodexAuth: vi.fn(),
  initializeFontSize: vi.fn(),
  logInfo: vi.fn(),
  resetUpdater: vi.fn(),
}));

vi.mock("./log", () => ({ info: mocks.logInfo }));
vi.mock("./stores/auth", () => ({
  useAuthStore: { getState: () => ({ initialize: mocks.initializeAuth }) },
}));
vi.mock("./stores/codex-auth", () => ({
  useCodexAuthStore: { getState: () => ({ initialize: mocks.initializeCodexAuth }) },
}));
vi.mock("./stores/conversations", () => ({
  useConversationsStore: {
    getState: () => ({ fetchConversations: mocks.fetchConversations }),
  },
}));
vi.mock("./stores/font-size", () => ({
  useFontSizeStore: { getState: () => ({ initialize: mocks.initializeFontSize }) },
}));
vi.mock("./stores/tools", () => ({
  useToolsStore: {
    getState: () => ({
      discoverSkills: mocks.discoverSkills,
      initializeMcp: mocks.activateMcp,
      initializeAuthMcp: mocks.initializeAuthMcp,
    }),
  },
}));
vi.mock("./stores/updater", () => ({
  useUpdaterStore: {
    getState: () => ({
      checkForUpdates: mocks.checkForUpdates,
      reset: mocks.resetUpdater,
    }),
  },
}));

type DesktopLifecycle = typeof import("./desktop-lifecycle");
let lifecycle: DesktopLifecycle;

describe("desktop lifecycle", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.resetModules();
    lifecycle = await import("./desktop-lifecycle");
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("does not activate Agent Chat MCP integrations during normal startup", () => {
    const cleanup = lifecycle.initializeDesktopStartup();

    expect(mocks.initializeAuth).toHaveBeenCalledOnce();
    expect(mocks.discoverSkills).toHaveBeenCalledOnce();
    expect(mocks.initializeCodexAuth).toHaveBeenCalledOnce();
    expect(mocks.fetchConversations).toHaveBeenCalledOnce();
    expect(mocks.initializeFontSize).toHaveBeenCalledOnce();
    expect(mocks.checkForUpdates).toHaveBeenCalledOnce();
    expect(mocks.activateMcp).not.toHaveBeenCalled();
    expect(mocks.initializeAuthMcp).not.toHaveBeenCalled();

    cleanup();
    expect(mocks.resetUpdater).toHaveBeenCalledOnce();
  });

  it("ignores auth synchronization until Agent Chat is explicitly activated", () => {
    lifecycle.syncAgentChatMcpAuth("startup-token");
    lifecycle.syncAgentChatMcpAuth(null);

    expect(mocks.activateMcp).not.toHaveBeenCalled();
    expect(mocks.initializeAuthMcp).not.toHaveBeenCalled();
  });

  it("coalesces the StrictMode setup-cleanup-setup cycle", () => {
    const firstCleanup = lifecycle.activateAgentChatMcp("user-a-token");
    firstCleanup();
    const secondCleanup = lifecycle.activateAgentChatMcp("user-a-token");

    vi.runAllTimers();

    expect(mocks.activateMcp).toHaveBeenCalledOnce();
    expect(mocks.initializeAuthMcp).toHaveBeenCalledOnce();
    expect(mocks.initializeAuthMcp).toHaveBeenLastCalledWith("user-a-token");

    secondCleanup();
    vi.runAllTimers();

    expect(mocks.initializeAuthMcp).toHaveBeenLastCalledWith(null);
  });

  it("keeps global MCP initialization idempotent across route unmount and remount", () => {
    const firstCleanup = lifecycle.activateAgentChatMcp("user-a-token");
    firstCleanup();
    vi.runAllTimers();

    const secondCleanup = lifecycle.activateAgentChatMcp("user-b-token");

    expect(mocks.activateMcp).toHaveBeenCalledOnce();
    expect(mocks.initializeAuthMcp.mock.calls).toEqual([
      ["user-a-token"],
      [null],
      ["user-b-token"],
    ]);

    secondCleanup();
  });

  it("refreshes account tokens and clears authenticated clients on logout", () => {
    lifecycle.activateAgentChatMcp("user-a-token");
    lifecycle.syncAgentChatMcpAuth("user-b-token");
    lifecycle.syncAgentChatMcpAuth(null);
    lifecycle.syncAgentChatMcpAuth(null);

    expect(mocks.initializeAuthMcp.mock.calls).toEqual([
      ["user-a-token"],
      ["user-b-token"],
      [null],
    ]);
  });
});
