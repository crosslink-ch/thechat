import { wsEvents } from "./ws-events";
import { useAuthStore } from "../stores/auth";
import { useWorkspacesStore } from "../stores/workspaces";
import { useNotificationsStore } from "../stores/notifications";
import { useConversationsStore } from "../stores/conversations";
import {
  hermesScopeKey,
  useHermesIndicatorsStore,
} from "../stores/hermes-indicators";
import { fireNotification } from "./notifications";
import { api } from "./api";
import type { WorkspaceWithDetails } from "@thechat/shared";
import type { WsEvents } from "./ws-events";

type Navigate = (opts: { to: string }) => void;

const DIRECT_NOTIFICATION_BODY_MAX_CHARS = 240;

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
    const currentUserId = useAuthStore.getState().user?.id;
    if (conversationType === "group") {
      useConversationsStore.getState().markChannelUnread(msg.conversationId);
    }
    if (conversationType === "direct" && msg.senderId !== currentUserId) {
      useHermesIndicatorsStore.getState().markScopeUnread({
        conversationId: msg.conversationId,
        threadId: msg.threadId ?? null,
        botUserId: msg.senderType === "bot" ? msg.senderId : null,
      });
    }
    if (
      conversationType === "direct" &&
      msg.senderId !== currentUserId &&
      !isVisibleHermesConversation(msg.conversationId)
    ) {
      fireNotification(msg.senderName, notificationBodyPreview(msg.content), {
        dedupeKey: `message:${msg.id}`,
      });
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
      navigate({ to: "/" });
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
      { dedupeKey: `workspace-invite:${invite.id}` },
    );
  };

  const onBotInvocationUpdated = ({
    invocation,
  }: WsEvents["ws:bot_invocation_updated"]) => {
    useHermesIndicatorsStore.getState().trackInvocation(invocation);
  };

  const onBotInvocationProgress = ({
    event,
  }: WsEvents["ws:bot_invocation_progress"]) => {
    useHermesIndicatorsStore.getState().trackProgressEvent(event);
  };

  wsEvents.on("ws:new_message", onNewMessage);
  wsEvents.on("ws:member_joined", onMemberJoined);
  wsEvents.on("ws:member_role_changed", onMemberRoleChanged);
  wsEvents.on("ws:member_removed", onMemberRemoved);
  wsEvents.on("ws:invite_received", onInviteReceived);
  wsEvents.on("ws:bot_invocation_updated", onBotInvocationUpdated);
  wsEvents.on("ws:bot_invocation_progress", onBotInvocationProgress);

  return () => {
    wsEvents.off("ws:new_message", onNewMessage);
    wsEvents.off("ws:member_joined", onMemberJoined);
    wsEvents.off("ws:member_role_changed", onMemberRoleChanged);
    wsEvents.off("ws:member_removed", onMemberRemoved);
    wsEvents.off("ws:invite_received", onInviteReceived);
    wsEvents.off("ws:bot_invocation_updated", onBotInvocationUpdated);
    wsEvents.off("ws:bot_invocation_progress", onBotInvocationProgress);
  };
}

function isVisibleHermesConversation(conversationId: string) {
  const visibleScope = useHermesIndicatorsStore.getState().visibleScope;
  return (
    visibleScope === hermesScopeKey(conversationId, null) ||
    visibleScope?.startsWith(`${conversationId}:thread:`) === true
  );
}

function notificationBodyPreview(content: string) {
  const normalized = content.trim().replace(/\s+/g, " ");
  if (normalized.length <= DIRECT_NOTIFICATION_BODY_MAX_CHARS) return normalized;
  return `${normalized.slice(0, DIRECT_NOTIFICATION_BODY_MAX_CHARS - 1).trimEnd()}…`;
}
