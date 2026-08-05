import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activateMcp: vi.fn(),
  checkForUpdates: vi.fn(),
  discoverSkills: vi.fn(),
  fetchConversations: vi.fn(),
  initializeAuth: vi.fn(),
  initializeAuthMcp: vi.fn(),
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

import {
  activateAgentChatMcp,
  initializeDesktopStartup,
  syncAgentChatMcpAuth,
} from "./desktop-lifecycle";

describe("desktop lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not activate Agent Chat MCP integrations during normal startup", () => {
    const cleanup = initializeDesktopStartup();

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

  it("activates MCP integrations only through the explicit Agent Chat lifecycle", () => {
    activateAgentChatMcp();
    syncAgentChatMcpAuth(null);

    expect(mocks.activateMcp).toHaveBeenCalledOnce();
    expect(mocks.initializeAuthMcp).not.toHaveBeenCalled();

    syncAgentChatMcpAuth("access-token");
    expect(mocks.initializeAuthMcp).toHaveBeenCalledOnce();
    expect(mocks.initializeAuthMcp).toHaveBeenCalledWith("access-token");
  });
});
