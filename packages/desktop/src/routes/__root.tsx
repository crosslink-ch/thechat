import { isWeb } from "../platform/environment";
import { useEffect } from "react";
import { Outlet, useNavigate } from "@tanstack/react-router";
import { useAuthStore } from "../stores/auth";
import { useWebSocketStore } from "../stores/websocket";
import { useWorkspacesStore } from "../stores/workspaces";
import { useNotificationsStore } from "../stores/notifications";
import { useActivityStore } from "../stores/activity";
import { useKeybindings } from "../hooks/useKeybindings";
import { Sidebar } from "../components/Sidebar";
import { ChatHeader } from "../components/ChatHeader";
import { CommandPalette } from "../CommandPalette";
import { AuthModal, AuthOnboarding } from "../components/AuthModal";
import { WorkspaceModal } from "../components/WorkspaceModal";
import { ChannelModal } from "../components/ChannelModal";
import { HermesBotModal } from "../components/HermesBotModal";
import { registerGlobalWsHandlers } from "../lib/ws-global-handlers";
import { createCommands, useCommandsStore } from "../commands";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { useCtrlWheelZoom } from "../hooks/useCtrlWheelZoom";
import { PlatformDialogs, PlatformTitlebar, PlatformUpdateToast, usePlatformLifecycle } from "#platform-shell";

export function RootLayout() {
  const navigate = useNavigate();
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const authLoading = useAuthStore((s) => s.loading);
  const identity = isWeb ? user?.id ?? null : token;
  usePlatformLifecycle(token);

  // Identity, not bearer truthiness: cookie sessions deliberately have no token.
  useEffect(() => {
    if (!identity) return;
    useWebSocketStore.getState().connect(token);
    void useWorkspacesStore.getState().initialize();
    void useNotificationsStore.getState().fetchNotifications();
    return () => {
      useWebSocketStore.getState().disconnect();
      useWorkspacesStore.getState().reset();
      useNotificationsStore.getState().reset();
    };
  }, [identity, token]);

  // Reconcile persisted Activity for both restored bearer and cookie sessions.
  useEffect(() => {
    if (identity) {
      void useActivityStore.getState().fetchActivity();
    } else {
      useActivityStore.getState().reset();
    }
  }, [identity, token]);

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

  return <RootView key={isWeb ? identity ?? "anonymous" : "desktop"} authLoading={authLoading} authenticated={Boolean(user)} />;
}

interface RootViewProps {
  authLoading: boolean;
  authenticated: boolean;
}

export function RootView({ authLoading, authenticated }: RootViewProps) {
  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-base">
      <PlatformTitlebar />
      {authLoading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-[0.929rem] text-text-placeholder">
          Loading...
        </div>
      ) : !authenticated ? (
        <AuthOnboarding />
      ) : (
        <>
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
          <PlatformDialogs />
          <AuthModal />
          <WorkspaceModal />
          <ChannelModal />
          <HermesBotModal />
        </>
      )}
      <PlatformUpdateToast />
    </div>
  );
}
