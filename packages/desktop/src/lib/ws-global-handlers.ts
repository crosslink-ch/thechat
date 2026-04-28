import { wsEvents } from "./ws-events";
import { useAuthStore } from "../stores/auth";
import { useWorkspacesStore } from "../stores/workspaces";
import { useNotificationsStore } from "../stores/notifications";
import { useConversationsStore } from "../stores/conversations";
import { fireNotification } from "./notifications";
import { api } from "./api";
import type { WorkspaceWithDetails } from "@thechat/shared";
import type { WsEvents } from "./ws-events";

type Navigate = (opts: { to: string }) => void;

function auth(token: string) {
  return { headers: { authorization: `Bearer ${token}` } };
}

async function refreshWorkspaceDetails(workspaceId: string) {
  const token = useAuthStore.getState().token;
  if (!token) return;

  const current = useWorkspacesStore.getState().activeWorkspace;
  if (!current || current.id !== workspaceId) return;

  try {
    const { data, error } = await api.workspaces({ id: workspaceId }).get(auth(token));
    if (error || !data) return;

    const latest = data as WorkspaceWithDetails;
    const stillCurrent = useWorkspacesStore.getState().activeWorkspace;
    if (!stillCurrent || stillCurrent.id !== workspaceId) return;

    useWorkspacesStore.setState({ activeWorkspace: latest });
  } catch {
    // Keep optimistic state if refresh fails.
  }
}

export function registerGlobalWsHandlers(navigate: Navigate): () => void {
  const onNewMessage = ({
    message: msg,
    conversationType,
  }: WsEvents["ws:new_message"]) => {
    if (conversationType === "group") {
      useConversationsStore.getState().markChannelUnread(msg.conversationId);
    }
    const currentUserId = useAuthStore.getState().user?.id;
    if (conversationType === "direct" && msg.senderId !== currentUserId) {
      fireNotification(msg.senderName, msg.content);
    }
  };

  const onMemberJoined = ({
    workspaceId,
    member,
  }: WsEvents["ws:member_joined"]) => {
    const { activeWorkspace } = useWorkspacesStore.getState();
    if (!activeWorkspace || activeWorkspace.id !== workspaceId) return;
    if (activeWorkspace.members.some((m) => m.userId === member.userId)) {
      void refreshWorkspaceDetails(workspaceId);
      return;
    }

    useWorkspacesStore.setState({
      activeWorkspace: {
        ...activeWorkspace,
        members: [...activeWorkspace.members, member],
      },
    });

    void refreshWorkspaceDetails(workspaceId);
  };

  const onMemberRoleChanged = ({
    workspaceId,
    userId,
    newRole,
  }: WsEvents["ws:member_role_changed"]) => {
    const { activeWorkspace } = useWorkspacesStore.getState();
    if (!activeWorkspace || activeWorkspace.id !== workspaceId) return;
    useWorkspacesStore.setState({
      activeWorkspace: {
        ...activeWorkspace,
        members: activeWorkspace.members.map((m) =>
          m.userId === userId ? { ...m, role: newRole } : m,
        ),
      },
    });
  };

  const onMemberRemoved = ({
    workspaceId,
    userId,
  }: WsEvents["ws:member_removed"]) => {
    const { activeWorkspace } = useWorkspacesStore.getState();
    if (!activeWorkspace || activeWorkspace.id !== workspaceId) return;

    const currentUserId = useAuthStore.getState().user?.id;
    if (userId === currentUserId) {
      useWorkspacesStore.setState({ activeWorkspace: null });
      useWorkspacesStore.getState().initialize();
      navigate({ to: "/chat" });
      return;
    }

    useWorkspacesStore.setState({
      activeWorkspace: {
        ...activeWorkspace,
        members: activeWorkspace.members.filter((m) => m.userId !== userId),
      },
    });
  };

  const onInviteReceived = ({
    invite,
  }: WsEvents["ws:invite_received"]) => {
    useNotificationsStore.getState().addNotification({
      type: "workspace_invite",
      invite,
    });
    fireNotification(
      "Workspace Invite",
      `${invite.inviterName} invited you to ${invite.workspaceName}`,
    );
  };

  wsEvents.on("ws:new_message", onNewMessage);
  wsEvents.on("ws:member_joined", onMemberJoined);
  wsEvents.on("ws:member_role_changed", onMemberRoleChanged);
  wsEvents.on("ws:member_removed", onMemberRemoved);
  wsEvents.on("ws:invite_received", onInviteReceived);

  return () => {
    wsEvents.off("ws:new_message", onNewMessage);
    wsEvents.off("ws:member_joined", onMemberJoined);
    wsEvents.off("ws:member_role_changed", onMemberRoleChanged);
    wsEvents.off("ws:member_removed", onMemberRemoved);
    wsEvents.off("ws:invite_received", onInviteReceived);
  };
}
