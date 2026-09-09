import { isWeb } from "../platform/environment";
import { useEffect } from "react";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { AppViewport } from "../components/AppViewport";
import { ResponsiveShell } from "../components/ResponsiveShell";
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
import { ReleaseNotesHost } from "../components/ReleaseNotes";

export function RootLayout() {
  const navigate = useNavigate();
  const routeKey = useRouterState({ select: (state) => state.location.href });
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

  return <RootView key={isWeb ? identity ?? "anonymous" : "desktop"} authLoading={authLoading} authenticated={Boolean(user)} userId={user?.id ?? null} routeKey={routeKey} />;
}

interface RootViewProps {
  authLoading: boolean;
  authenticated: boolean;
  userId?: string | null;
  routeKey?: string;
}

export function RootView({ authLoading, authenticated, userId = null, routeKey = "" }: RootViewProps) {
  return (
    <AppViewport className="relative flex flex-col bg-base">
      <PlatformTitlebar />
      {authLoading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-[0.929rem] text-text-placeholder">
          Loading...
        </div>
      ) : !authenticated ? (
        <AuthOnboarding />
      ) : (
        <>
          <ResponsiveShell navigation={<Sidebar />} routeKey={routeKey}>
              <ChatHeader />
              <ErrorBoundary name="Route">
                <Outlet />
              </ErrorBoundary>
          </ResponsiveShell>
          <CommandPalette />
          <PlatformDialogs />
          <AuthModal />
          <WorkspaceModal />
          <ChannelModal />
          <HermesBotModal />
        </>
      )}
      <PlatformUpdateToast />
      <ReleaseNotesHost userId={!authLoading && authenticated ? userId : null} autoShow={!import.meta.env.DEV} />
    </AppViewport>
  );
}
