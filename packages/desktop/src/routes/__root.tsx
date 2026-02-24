import { useEffect, useRef } from "react";
import { Outlet, useNavigate } from "@tanstack/react-router";
import { useAuthStore } from "../stores/auth";
import { useToolsStore } from "../stores/tools";
import { useWebSocketStore } from "../stores/websocket";
import { useWorkspacesStore } from "../stores/workspaces";
import { useNotificationsStore } from "../stores/notifications";
import { useConversationsStore } from "../stores/conversations";
import { useKeybindings } from "../hooks/useKeybindings";
import { Sidebar } from "../components/Sidebar";
import { ChatHeader } from "../components/ChatHeader";
import { CommandPalette } from "../CommandPalette";
import { AuthModal } from "../components/AuthModal";
import { WorkspaceModal } from "../components/WorkspaceModal";
import { registerGlobalWsHandlers } from "../lib/ws-global-handlers";
import { createCommands, useCommandsStore } from "../commands";
import { checkForUpdates } from "../lib/updater";

export function RootLayout() {
  const navigate = useNavigate();
  const token = useAuthStore((s) => s.token);
  const tools = useToolsStore((s) => s.tools);
  const prevTokenRef = useRef(token);

  // Initialize auth on mount
  useEffect(() => {
    useAuthStore.getState().initialize();
    useToolsStore.getState().initializeMcp();
    useToolsStore.getState().discoverSkills();
    useConversationsStore.getState().fetchConversations();
    checkForUpdates();
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

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <ChatHeader />
        <Outlet />
      </div>
      <CommandPalette />
      <AuthModal />
      <WorkspaceModal />
    </div>
  );
}
