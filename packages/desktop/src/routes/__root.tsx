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
import { CommandPalette, togglePalette } from "../CommandPalette";
import { AuthModal } from "../components/AuthModal";
import { WorkspaceModal } from "../components/WorkspaceModal";
import { fireNotification } from "../lib/notifications";
import { resetTodos } from "../core/todo";

export function RootLayout() {
  const navigate = useNavigate();
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const tools = useToolsStore((s) => s.tools);
  const prevTokenRef = useRef(token);
  const userRef = useRef(user);
  userRef.current = user;

  // Initialize auth on mount
  useEffect(() => {
    useAuthStore.getState().initialize();
    useToolsStore.getState().initializeMcp();
    useToolsStore.getState().discoverSkills();
    useConversationsStore.getState().fetchConversations();
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

  // WebSocket message listener for unread tracking + notifications (global)
  useEffect(() => {
    const unsubMessages = useWebSocketStore.getState().subscribeToMessages(
      (msg, conversationType) => {
        if (conversationType === "group") {
          useConversationsStore.getState().markChannelUnread(msg.conversationId);
        }
        if (
          conversationType === "direct" &&
          msg.senderId !== userRef.current?.id
        ) {
          fireNotification(msg.senderName, msg.content);
        }
      },
    );
    return unsubMessages;
  }, []);

  // WebSocket member_joined listener — update active workspace members list
  useEffect(() => {
    const unsub = useWebSocketStore.getState().subscribeToMemberJoined(
      (workspaceId, member) => {
        const { activeWorkspace } = useWorkspacesStore.getState();
        if (!activeWorkspace || activeWorkspace.id !== workspaceId) return;
        // Guard against duplicates (idempotent)
        if (activeWorkspace.members.some((m) => m.userId === member.userId)) return;
        useWorkspacesStore.setState({
          activeWorkspace: {
            ...activeWorkspace,
            members: [...activeWorkspace.members, member],
          },
        });
      },
    );
    return unsub;
  }, []);

  // WebSocket invite_received listener — add notification + fire OS notification
  useEffect(() => {
    const unsub = useWebSocketStore.getState().subscribeToInviteReceived(
      (invite) => {
        useNotificationsStore.getState().addNotification({
          type: "workspace_invite",
          invite,
        });
        fireNotification(
          "Workspace Invite",
          `${invite.inviterName} invited you to ${invite.workspaceName}`
        );
      },
    );
    return unsub;
  }, []);

  // Keybindings
  const handleNewConversation = () => {
    resetTodos();
    navigate({ to: "/chat" });
  };

  useKeybindings({
    onNewChat: handleNewConversation,
    onPaletteToggle: togglePalette,
    onPermissionAllow: null,
    onPermissionDeny: null,
    onPermissionDenyWithFeedback: null,
  });

  return (
    <div className="app">
      <Sidebar />
      <div className="chat-main">
        <ChatHeader />
        <Outlet />
      </div>
      <CommandPalette />
      <AuthModal />
      <WorkspaceModal />
    </div>
  );
}
