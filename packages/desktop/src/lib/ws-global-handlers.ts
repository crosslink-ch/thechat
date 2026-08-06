import { wsEvents } from "./ws-events";
import { useAuthStore } from "../stores/auth";
import {
  updateExistingWorkspaceChannel,
  upsertWorkspaceChannel,
  useWorkspacesStore,
} from "../stores/workspaces";
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

async function refreshWorkspaceDetails(
  workspaceId: string,
  isLatestRequest: () => boolean = () => true,
) {
  const token = useAuthStore.getState().token;
  if (!token) return;

  const current = useWorkspacesStore.getState().activeWorkspace;
  if (!current || current.id !== workspaceId) return;

  try {
    const { data, error } = await api.workspaces({ id: workspaceId }).get(auth(token));
    if (error || !data) return;

    const latest = data as WorkspaceWithDetails;
    const stillCurrent = useWorkspacesStore.getState().activeWorkspace;
    if (
      !stillCurrent ||
      stillCurrent.id !== workspaceId ||
      !isLatestRequest()
    ) return;

    useWorkspacesStore.setState({ activeWorkspace: latest });
  } catch {
    // Keep optimistic state if refresh fails.
  }
}

function currentWindowRoutePath() {
  const hashPath = window.location.hash.replace(/^#/, "").split("?")[0];
  return hashPath.startsWith("/") ? hashPath : window.location.pathname;
}

export function registerGlobalWsHandlers(
  navigate: Navigate,
  currentPath: () => string = currentWindowRoutePath,
): () => void {
  const deletedChannelIds = new Set<string>();
  let workspaceRefreshGeneration = 0;

  const reconcileWorkspace = (workspaceId: string) => {
    if (useWorkspacesStore.getState().activeWorkspace?.id !== workspaceId) return;
    const generation = ++workspaceRefreshGeneration;
    void refreshWorkspaceDetails(
      workspaceId,
      () => generation === workspaceRefreshGeneration,
    );
  };

  const onAuthenticated = () => {
    const workspaceId = useWorkspacesStore.getState().activeWorkspace?.id;
    if (workspaceId) reconcileWorkspace(workspaceId);
    void useNotificationsStore.getState().fetchNotifications();
  };

  const onNewMessage = ({
    message: msg,
    conversationType,
  }: WsEvents["ws:new_message"]) => {
    const currentUserId = useAuthStore.getState().user?.id;
    if (conversationType === "group") {
      useConversationsStore.getState().markChannelUnread(msg.conversationId);
    }
    if (conversationType === "direct" && msg.senderId !== currentUserId) {
      const conversations = useConversationsStore.getState();
      if (msg.senderType === "bot") {
        conversations.markBotConversationUnread(msg.conversationId, msg.senderId);
      } else {
        conversations.rememberDirectConversation(msg.senderId, msg.conversationId);
      }
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
    const { activeWorkspace, workspaces } = useWorkspacesStore.getState();
    const currentUserId = useAuthStore.getState().user?.id;
    useWorkspacesStore.setState({
      workspaces:
        userId === currentUserId
          ? workspaces.map((workspace) =>
              workspace.id === workspaceId ? { ...workspace, role: newRole } : workspace,
            )
          : workspaces,
      activeWorkspace:
        activeWorkspace?.id === workspaceId
          ? {
              ...activeWorkspace,
              members: activeWorkspace.members.map((member) =>
                member.userId === userId ? { ...member, role: newRole } : member,
              ),
            }
          : activeWorkspace,
    });
  };

  const onMemberUpdated = ({
    workspaceId,
    userId,
    name,
  }: WsEvents["ws:member_updated"]) => {
    const { activeWorkspace } = useWorkspacesStore.getState();
    if (!activeWorkspace || activeWorkspace.id !== workspaceId) return;
    useWorkspacesStore.setState({
      activeWorkspace: {
        ...activeWorkspace,
        members: activeWorkspace.members.map((member) =>
          member.userId === userId
            ? { ...member, user: { ...member.user, name } }
            : member,
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

  const onChannelCreated = ({
    workspaceId,
    channel,
  }: WsEvents["ws:channel_created"]) => {
    if (deletedChannelIds.has(channel.id)) return;
    useWorkspacesStore.setState((state) => {
      if (state.activeWorkspace?.id !== workspaceId) return state;
      return {
        activeWorkspace: {
          ...state.activeWorkspace,
          channels: upsertWorkspaceChannel(
            state.activeWorkspace.channels,
            channel,
          ),
        },
      };
    });
    reconcileWorkspace(workspaceId);
  };

  const onChannelRenamed = ({
    workspaceId,
    channel,
  }: WsEvents["ws:channel_renamed"]) => {
    if (deletedChannelIds.has(channel.id)) return;
    useWorkspacesStore.setState((state) => {
      if (state.activeWorkspace?.id !== workspaceId) return state;
      return {
        activeWorkspace: {
          ...state.activeWorkspace,
          channels: updateExistingWorkspaceChannel(
            state.activeWorkspace.channels,
            channel,
          ),
        },
      };
    });
    reconcileWorkspace(workspaceId);
  };

  const onChannelDeleted = ({
    workspaceId,
    channelId,
  }: WsEvents["ws:channel_deleted"]) => {
    deletedChannelIds.add(channelId);
    let fallbackChannelId: string | null = null;
    useWorkspacesStore.setState((state) => {
      if (state.activeWorkspace?.id !== workspaceId) return state;
      const deletedIndex = state.activeWorkspace.channels.findIndex(
        (channel) => channel.id === channelId,
      );
      const channels = state.activeWorkspace.channels.filter(
        (channel) => channel.id !== channelId,
      );
      fallbackChannelId =
        channels[Math.min(Math.max(deletedIndex, 0), channels.length - 1)]?.id ??
        null;
      return {
        activeWorkspace: { ...state.activeWorkspace, channels },
      };
    });
    useConversationsStore.getState().markChannelRead(channelId);

    if (currentPath() === `/channel/${channelId}`) {
      navigate({
        to: fallbackChannelId ? `/channel/${fallbackChannelId}` : "/",
      });
    }
    reconcileWorkspace(workspaceId);
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

  const onBotWorkspaceInviteReceived = ({
    invite,
  }: WsEvents["ws:bot_workspace_invite_received"]) => {
    useNotificationsStore.getState().addNotification({
      type: "bot_workspace_invite",
      invite,
    });
    fireNotification(
      "Bot approval requested",
      `${invite.requesterName} wants to add ${invite.botName} to ${invite.workspaceName}`,
      { dedupeKey: `bot-workspace-invite:${invite.id}` },
    );
  };

  const onBotWorkspaceInviteResolved = (
    event: WsEvents["ws:bot_workspace_invite_resolved"],
  ) => {
    useNotificationsStore.getState().handleRealtimeEvent({
      type: "bot_workspace_invite_resolved",
      ...event,
    });
  };

  const onBotInvocationUpdated = ({
    invocation,
  }: WsEvents["ws:bot_invocation_updated"]) => {
    useHermesIndicatorsStore.getState().trackInvocation(invocation);
  };

  const onBotInvocationProgress = ({
    event,
    invocation,
  }: WsEvents["ws:bot_invocation_progress"]) => {
    useHermesIndicatorsStore.getState().trackProgressEvent(event, invocation);
  };

  wsEvents.on("ws:authenticated", onAuthenticated);
  wsEvents.on("ws:new_message", onNewMessage);
  wsEvents.on("ws:member_joined", onMemberJoined);
  wsEvents.on("ws:member_role_changed", onMemberRoleChanged);
  wsEvents.on("ws:member_updated", onMemberUpdated);
  wsEvents.on("ws:member_removed", onMemberRemoved);
  wsEvents.on("ws:channel_created", onChannelCreated);
  wsEvents.on("ws:channel_renamed", onChannelRenamed);
  wsEvents.on("ws:channel_deleted", onChannelDeleted);
  wsEvents.on("ws:invite_received", onInviteReceived);
  wsEvents.on("ws:bot_workspace_invite_received", onBotWorkspaceInviteReceived);
  wsEvents.on("ws:bot_workspace_invite_resolved", onBotWorkspaceInviteResolved);
  wsEvents.on("ws:bot_invocation_updated", onBotInvocationUpdated);
  wsEvents.on("ws:bot_invocation_progress", onBotInvocationProgress);

  return () => {
    workspaceRefreshGeneration += 1;
    wsEvents.off("ws:authenticated", onAuthenticated);
    wsEvents.off("ws:new_message", onNewMessage);
    wsEvents.off("ws:member_joined", onMemberJoined);
    wsEvents.off("ws:member_role_changed", onMemberRoleChanged);
    wsEvents.off("ws:member_updated", onMemberUpdated);
    wsEvents.off("ws:member_removed", onMemberRemoved);
    wsEvents.off("ws:channel_created", onChannelCreated);
    wsEvents.off("ws:channel_renamed", onChannelRenamed);
    wsEvents.off("ws:channel_deleted", onChannelDeleted);
    wsEvents.off("ws:invite_received", onInviteReceived);
    wsEvents.off("ws:bot_workspace_invite_received", onBotWorkspaceInviteReceived);
    wsEvents.off("ws:bot_workspace_invite_resolved", onBotWorkspaceInviteResolved);
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
