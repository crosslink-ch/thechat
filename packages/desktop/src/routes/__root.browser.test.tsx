import type { ReactNode } from "react";
import { act, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const authState = {
    token: null as string | null,
    user: { id: "user-1", name: "Startup User", email: "startup@example.com" },
    loading: false,
    initialize: vi.fn(),
  };

  return {
    authState,
    checkForUpdates: vi.fn(),
    createCommands: vi.fn(() => []),
    disconnect: vi.fn(),
    fetchConversations: vi.fn(),
    fetchNotifications: vi.fn(),
    initializeCodexAuth: vi.fn(),
    initializeFontSize: vi.fn(),
    initializeWorkspaces: vi.fn(),
    logInfo: vi.fn(),
    navigate: vi.fn(),
    registerGlobalWsHandlers: vi.fn(() => vi.fn()),
    resetNotifications: vi.fn(),
    resetUpdater: vi.fn(),
    resetWorkspaces: vi.fn(),
    setCommands: vi.fn(),
    connect: vi.fn(),
  };
});

vi.mock("@tanstack/react-router", () => ({
  Outlet: () => <div data-testid="outlet" />,
  useNavigate: () => mocks.navigate,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(vi.fn())),
}));
vi.mock("../log", () => ({
  error: vi.fn(),
  formatError: (error: unknown) => String(error),
  info: mocks.logInfo,
  warn: vi.fn(),
}));
vi.mock("../core/skills", () => ({
  discoverSkills: vi.fn(() => Promise.resolve([])),
}));
vi.mock("../stores/auth", () => ({
  useAuthStore: Object.assign(
    (selector: (state: typeof mocks.authState) => unknown) => selector(mocks.authState),
    { getState: () => mocks.authState },
  ),
}));
vi.mock("../stores/codex-auth", () => ({
  useCodexAuthStore: {
    getState: () => ({ initialize: mocks.initializeCodexAuth }),
  },
}));
vi.mock("../stores/conversations", () => ({
  useConversationsStore: {
    getState: () => ({ fetchConversations: mocks.fetchConversations }),
  },
}));
vi.mock("../stores/font-size", () => ({
  useFontSizeStore: {
    getState: () => ({ initialize: mocks.initializeFontSize }),
  },
}));
vi.mock("../stores/updater", () => ({
  useUpdaterStore: {
    getState: () => ({
      checkForUpdates: mocks.checkForUpdates,
      reset: mocks.resetUpdater,
    }),
  },
}));
vi.mock("../stores/websocket", () => ({
  useWebSocketStore: {
    getState: () => ({ connect: mocks.connect, disconnect: mocks.disconnect }),
  },
}));
vi.mock("../stores/workspaces", () => ({
  useWorkspacesStore: {
    getState: () => ({
      initialize: mocks.initializeWorkspaces,
      reset: mocks.resetWorkspaces,
    }),
  },
}));
vi.mock("../stores/notifications", () => ({
  useNotificationsStore: {
    getState: () => ({
      fetchNotifications: mocks.fetchNotifications,
      reset: mocks.resetNotifications,
    }),
  },
}));
vi.mock("../hooks/useKeybindings", () => ({ useKeybindings: vi.fn() }));
vi.mock("../hooks/useCtrlWheelZoom", () => ({ useCtrlWheelZoom: vi.fn() }));
vi.mock("../lib/ws-global-handlers", () => ({
  registerGlobalWsHandlers: mocks.registerGlobalWsHandlers,
}));
vi.mock("../commands", () => ({
  createCommands: mocks.createCommands,
  useCommandsStore: { getState: () => ({ setCommands: mocks.setCommands }) },
}));

vi.mock("../components/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("../components/ChatHeader", () => ({ ChatHeader: () => null }));
vi.mock("../components/WindowTitlebar", () => ({ WindowTitlebar: () => null }));
vi.mock("../CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("../PermissionModePicker", () => ({ PermissionModePicker: () => null }));
vi.mock("../components/CodexAuthModal", () => ({ CodexAuthModal: () => null }));
vi.mock("../components/WorkspaceModal", () => ({ WorkspaceModal: () => null }));
vi.mock("../components/ChannelModal", () => ({ ChannelModal: () => null }));
vi.mock("../components/HermesBotModal", () => ({ HermesBotModal: () => null }));
vi.mock("../McpConfigDialog", () => ({ McpConfigDialog: () => null }));
vi.mock("../components/UpdateToast", () => ({ UpdateToast: () => null }));
vi.mock("../components/AuthModal", () => ({
  AuthModal: () => null,
  AuthOnboarding: () => null,
}));
vi.mock("../components/ErrorBoundary", () => ({
  ErrorBoundary: ({ children }: { children: ReactNode }) => children,
}));

import { RootLayout } from "./__root";


vi.mock("../platform/environment", () => ({ isWeb: true }));
it("connects a restored cookie identity and replaces account-scoped route state on identity changes", async () => {
  let mounted!: ReturnType<typeof render>;
  await act(async () => { mounted = render(<RootLayout />); });
  expect(mocks.connect).toHaveBeenCalledWith(null);
  expect(mocks.initializeWorkspaces).toHaveBeenCalledOnce();
  mocks.authState.user = { ...mocks.authState.user, id: "other-user" };
  await act(async () => { mounted.rerender(<RootLayout />); });
  expect(mocks.disconnect).toHaveBeenCalled();
  expect(mocks.connect).toHaveBeenCalledTimes(2);
  expect(mocks.initializeWorkspaces).toHaveBeenCalledTimes(2);
  mounted.unmount();
});
