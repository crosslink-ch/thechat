import { useEffect, useRef } from "react";
import { Outlet, useNavigate } from "@tanstack/react-router";
import { useAuthStore } from "../stores/auth";
import { useToolsStore } from "../stores/tools";
import { useWebSocketStore } from "../stores/websocket";
import { useWorkspacesStore } from "../stores/workspaces";
import { useNotificationsStore } from "../stores/notifications";
import { useKeybindings } from "../hooks/useKeybindings";
import { Sidebar } from "../components/Sidebar";
import { ChatHeader } from "../components/ChatHeader";
import { WindowTitlebar } from "../components/WindowTitlebar";
import { CommandPalette } from "../CommandPalette";
import { PermissionModePicker } from "../PermissionModePicker";
import { AuthModal, AuthOnboarding } from "../components/AuthModal";
import { CodexAuthModal } from "../components/CodexAuthModal";
import { WorkspaceModal } from "../components/WorkspaceModal";
import { ChannelModal } from "../components/ChannelModal";
import { HermesBotModal } from "../components/HermesBotModal";
import { McpConfigDialog } from "../McpConfigDialog";
import { registerGlobalWsHandlers } from "../lib/ws-global-handlers";
import { createCommands, useCommandsStore } from "../commands";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { UpdateToast } from "../components/UpdateToast";
import { useCtrlWheelZoom } from "../hooks/useCtrlWheelZoom";
import { initializeDesktopStartup } from "../desktop-lifecycle";

export function RootLayout() {
  const navigate = useNavigate();
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const authLoading = useAuthStore((s) => s.loading);
  const tools = useToolsStore((s) => s.tools);
  const prevTokenRef = useRef(token);

  // Initialize auth on mount
  useEffect(() => {
    return initializeDesktopStartup();
  }, []);

  // React to token changes: connect/disconnect WebSocket and initialize workspaces
  useEffect(() => {
    if (token && token !== prevTokenRef.current) {
      useWebSocketStore.getState().connect(token);
      useWorkspacesStore.getState().initialize();
      useNotificationsStore.getState().fetchNotifications();
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
    useCommandsStore.getState().setCommands(user ? createCommands(navigate) : []);
  }, [navigate, user]);

  // Keybindings
  useKeybindings({
    onPermissionAllow: null,
    onPermissionDeny: null,
    onPermissionDenyWithFeedback: null,
    handleRegistryCommands: Boolean(user),
  });
  useCtrlWheelZoom();

  if (authLoading) {
    return (
      <div className="relative flex h-screen flex-col overflow-hidden bg-base">
        <WindowTitlebar />
        <div className="flex min-h-0 flex-1 items-center justify-center text-[0.929rem] text-text-placeholder">
          Loading...
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="relative flex h-screen flex-col overflow-hidden bg-base">
        <WindowTitlebar />
        <AuthOnboarding />
      </div>
    );
  }

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-base">
      <WindowTitlebar />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <ChatHeader />
          <ErrorBoundary name="Route">
            <Outlet />
          </ErrorBoundary>
        </div>
      </div>
      <CommandPalette />
      <PermissionModePicker />
      <AuthModal />
      <CodexAuthModal />
      <WorkspaceModal />
      <ChannelModal />
      <HermesBotModal />
      <McpConfigDialog />
      <UpdateToast />
    </div>
  );
}
