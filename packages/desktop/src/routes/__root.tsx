import { useEffect, useRef } from "react";
import { Outlet, useNavigate } from "@tanstack/react-router";
import { useAuthStore } from "../stores/auth";
import { useToolsStore } from "../stores/tools";
import { useWebSocketStore } from "../stores/websocket";
import { useWorkspacesStore } from "../stores/workspaces";
import { useNotificationsStore } from "../stores/notifications";
import { useConversationsStore } from "../stores/conversations";
import { useKeybindings } from "../hooks/useKeybindings";
import { Sidebar, toggleSidebar, useSidebarState } from "../components/Sidebar";
import { ChatHeader } from "../components/ChatHeader";
import { CommandPalette } from "../CommandPalette";
import { PermissionModePicker } from "../PermissionModePicker";
import { SelectProjectPicker } from "../SelectProjectPicker";
import { AuthModal } from "../components/AuthModal";
import { CodexAuthModal } from "../components/CodexAuthModal";
import { WorkspaceModal } from "../components/WorkspaceModal";
import { McpConfigDialog } from "../McpConfigDialog";
import { useCodexAuthStore } from "../stores/codex-auth";
import { registerGlobalWsHandlers } from "../lib/ws-global-handlers";
import { createCommands, useCommandsStore } from "../commands";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { UpdateToast } from "../components/UpdateToast";
import { useUpdaterStore } from "../stores/updater";
import { useFontSizeStore } from "../stores/font-size";
import { info as logInfo } from "../log";

export function RootLayout() {
  const navigate = useNavigate();
  const token = useAuthStore((s) => s.token);
  const tools = useToolsStore((s) => s.tools);
  const prevTokenRef = useRef(token);

  // Initialize auth on mount
  useEffect(() => {
    logInfo("[root] Initializing app");
    useAuthStore.getState().initialize();
    useToolsStore.getState().initializeMcp();
    useToolsStore.getState().discoverSkills();
    useCodexAuthStore.getState().initialize();
    useConversationsStore.getState().fetchConversations();
    useFontSizeStore.getState().initialize();
    void useUpdaterStore.getState().checkForUpdates();

    return () => {
      void useUpdaterStore.getState().reset();
    };
  }, []);

  // React to token changes: connect/disconnect WebSocket, initialize workspaces, auth MCP
  useEffect(() => {
    if (token && token !== prevTokenRef.current) {
      useWebSocketStore.getState().connect(token);
      useWorkspacesStore.getState().initialize();
      useNotificationsStore.getState().fetchNotifications();
      useToolsStore.getState().initializeAuthMcp(token);
    } else if (!token && prevTokenRef.current) {
      useWebSocketStore.getState().disconnect();
      useWorkspacesStore.getState().reset();
      useNotificationsStore.getState().reset();
    }
    prevTokenRef.current = token;
  }, [token]);

  // React to tools changes: initialize task runner
  useEffect(() => {
    useToolsStore.getState().initializeTaskRunner();
  }, [tools]);

  // Global WebSocket event handlers
  useEffect(() => {
    return registerGlobalWsHandlers(navigate);
  }, [navigate]);

  // Initialize command registry
  useEffect(() => {
    useCommandsStore.getState().setCommands(createCommands(navigate));
  }, [navigate]);

  // Keybindings
  useKeybindings({
    onPermissionAllow: null,
    onPermissionDeny: null,
    onPermissionDenyWithFeedback: null,
    handleRegistryCommands: true,
  });

  const sidebarOpen = useSidebarState((s) => s.open);

  return (
    <div className="relative flex h-screen overflow-hidden">
      <Sidebar />
      {!sidebarOpen && (
        <button
          aria-label="Open sidebar"
          className="absolute top-3 left-3 z-20 flex size-8 cursor-pointer items-center justify-center rounded-md border border-border bg-raised text-text-muted transition-colors duration-150 hover:bg-hover hover:text-text"
          onClick={toggleSidebar}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 2.5H11" />
            <path d="M3 7H11" />
            <path d="M3 11.5H11" />
            <path d="M2.5 2.5V11.5" />
          </svg>
        </button>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <ChatHeader />
        <ErrorBoundary name="Route">
          <Outlet />
        </ErrorBoundary>
      </div>
      <CommandPalette />
      <PermissionModePicker />
      <SelectProjectPicker />
      <AuthModal />
      <CodexAuthModal />
      <WorkspaceModal />
      <McpConfigDialog />
      <UpdateToast />
    </div>
  );
}
