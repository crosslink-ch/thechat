import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type {
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
  WorkspaceChannel,
  WorkspaceWithDetails,
} from "@thechat/shared";
import { registerGlobalWsHandlers } from "./ws-global-handlers";
import { wsEvents } from "./ws-events";
import { fireNotification } from "./notifications";
import { useAuthStore } from "../stores/auth";
import { useWorkspacesStore } from "../stores/workspaces";
import { useNotificationsStore } from "../stores/notifications";
import { useConversationsStore } from "../stores/conversations";
import { usePresenceStore } from "../stores/presence";
import {
  hermesScopeKey,
  useHermesIndicatorsStore,
} from "../stores/hermes-indicators";

const { workspacesGetMock, workspacesRouteMock } = vi.hoisted(() => {
  const getMock = vi.fn();
  return {
    workspacesGetMock: getMock,
    workspacesRouteMock: vi.fn(() => ({ get: getMock })),
  };
});

vi.mock("./api", () => ({
  api: {
    workspaces: workspacesRouteMock,
  },
}));

vi.mock("./notifications", () => ({
  fireNotification: vi.fn(),
}));

const baseWorkspace: WorkspaceWithDetails = {
  id: "ws-1",
  name: "Workspace",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  channels: [],
  members: [
    {
      userId: "u-owner",
      role: "owner",
      joinedAt: "2026-01-01T00:00:00.000Z",
      user: {
        id: "u-owner",
        name: "Owner",
        email: "owner@example.com",
        avatar: null,
        type: "human",
      },
    },
  ],
};

describe("registerGlobalWsHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = "";
    useAuthStore.setState({ token: "token-1", user: null, loading: false });
    useHermesIndicatorsStore.getState().resetForTests();
    usePresenceStore.getState().clear();
    useNotificationsStore.setState({
      notifications: [],
      loading: false,
      fetchNotifications: vi.fn().mockResolvedValue(undefined),
    });
    useConversationsStore.setState({
      unreadChannels: new Set(),
      directConversationIdsByUserId: {},
      unreadDirectConversations: {},
      activeDirectConversationId: null,
    });
    useWorkspacesStore.setState({
      workspaces: [],
      activeWorkspace: structuredClone(baseWorkspace),
      loading: false,
    });
  });

  it("applies presence snapshots and incremental changes", () => {
    const cleanup = registerGlobalWsHandlers(() => {});

    wsEvents.emit("ws:presence_snapshot", { userIds: ["u-1", "u-2"] });
    wsEvents.emit("ws:presence_changed", { userId: "u-2", online: false });
    wsEvents.emit("ws:presence_changed", { userId: "u-3", online: true });

    expect([...usePresenceStore.getState().onlineUserIds].sort()).toEqual([
      "u-1",
      "u-3",
    ]);

    wsEvents.emit("ws:presence_snapshot", { userIds: [] });
    expect([...usePresenceStore.getState().onlineUserIds]).toEqual([]);
    cleanup();
  });

  it("does not fire a desktop notification for a background Hermes task in the visible DM", () => {
    useAuthStore.setState({
      token: "token-1",
      loading: false,
      user: {
        id: "u-me",
        name: "Me",
        email: "me@example.com",
        avatar: null,
        type: "human",
      },
    });
    useHermesIndicatorsStore
      .getState()
      .setVisibleScope(hermesScopeKey("conv-1", "active-thread"));

    const cleanup = registerGlobalWsHandlers(() => {});

    wsEvents.emit("ws:new_message", {
      conversationType: "direct",
      message: {
        id: "msg-1",
        conversationId: "conv-1",
        threadId: "background-thread",
        senderId: "u-bot",
        senderName: "Koda",
        senderType: "bot",
        content: "Background task finished.",
        parts: null,
        createdAt: "2026-06-11T10:00:00.000Z",
      },
    });

    expect(fireNotification).not.toHaveBeenCalled();
    expect(
      useHermesIndicatorsStore.getState().unreadScopes[
        hermesScopeKey("conv-1", "background-thread")
      ],
    ).toEqual({
      conversationId: "conv-1",
      threadId: "background-thread",
      botUserId: "u-bot",
    });

    cleanup();
  });

  it("marks General unread when a direct bot message arrives while a task is visible", () => {
    useAuthStore.setState({
      token: "token-1",
      loading: false,
      user: {
        id: "u-me",
        name: "Me",
        email: "me@example.com",
        avatar: null,
        type: "human",
      },
    });
    useHermesIndicatorsStore
      .getState()
      .setVisibleScope(hermesScopeKey("conv-1", "active-thread"));

    const cleanup = registerGlobalWsHandlers(() => {});

    wsEvents.emit("ws:new_message", {
      conversationType: "direct",
      message: {
        id: "msg-general",
        conversationId: "conv-1",
        threadId: null,
        senderId: "u-bot",
        senderName: "Koda",
        senderType: "bot",
        content: "Ok it's good now",
        parts: null,
        createdAt: "2026-06-11T10:05:00.000Z",
      },
    });

    expect(
      useHermesIndicatorsStore.getState().unreadScopes[
        hermesScopeKey("conv-1", null)
      ],
    ).toEqual({
      conversationId: "conv-1",
      threadId: null,
      botUserId: "u-bot",
    });
    expect(fireNotification).not.toHaveBeenCalled();

    useHermesIndicatorsStore
      .getState()
      .setVisibleScope(hermesScopeKey("conv-1", null));
    expect(useHermesIndicatorsStore.getState().unreadScopes).toEqual({});

    cleanup();
  });

  it("truncates direct-message desktop notification bodies", () => {
    useAuthStore.setState({
      token: "token-1",
      loading: false,
      user: {
        id: "u-me",
        name: "Me",
        email: "me@example.com",
        avatar: null,
        type: "human",
      },
    });
    const cleanup = registerGlobalWsHandlers(() => {});
    const longContent = Array.from({ length: 80 }, (_, index) => `word${index}`).join(" ");

    wsEvents.emit("ws:new_message", {
      conversationType: "direct",
      message: {
        id: "msg-2",
        conversationId: "conv-2",
        threadId: "background-thread",
        senderId: "u-bot",
        senderName: "Koda",
        senderType: "bot",
        content: longContent,
        parts: null,
        createdAt: "2026-06-11T10:00:00.000Z",
      },
    });

    expect(fireNotification).toHaveBeenCalledTimes(1);
    const [, body] = vi.mocked(fireNotification).mock.calls[0];
    expect(body.length).toBeLessThanOrEqual(240);
    expect(body.endsWith("…")).toBe(true);

    cleanup();
  });

  it("optimistically adds a joined member and refreshes workspace details", async () => {
    workspacesGetMock.mockResolvedValueOnce({
      data: {
        ...baseWorkspace,
        name: "Workspace (server)",
        members: [
          ...baseWorkspace.members,
          {
            userId: "u-bot",
            role: "member",
            joinedAt: "2026-01-02T00:00:00.000Z",
            user: {
              id: "u-bot",
              name: "Release Bot",
              email: null,
              avatar: null,
              type: "bot",
            },
          },
        ],
      },
      error: null,
    });

    const cleanup = registerGlobalWsHandlers(() => {});

    wsEvents.emit("ws:member_joined", {
      workspaceId: "ws-1",
      member: {
        userId: "u-bot",
        role: "member",
        joinedAt: "2026-01-02T00:00:00.000Z",
        user: {
          id: "u-bot",
          name: "Release Bot",
          email: null,
          avatar: null,
          type: "bot",
        },
      },
    });

    expect(
      useWorkspacesStore.getState().activeWorkspace?.members.some((m) => m.userId === "u-bot"),
    ).toBe(true);

    await Promise.resolve();
    await Promise.resolve();

    expect(workspacesRouteMock).toHaveBeenCalledWith({ id: "ws-1" });
    expect(useWorkspacesStore.getState().activeWorkspace?.name).toBe("Workspace (server)");

    cleanup();
  });

  it("updates the current user's role for a non-active workspace", () => {
    useAuthStore.setState({
      token: "token-1",
      loading: false,
      user: {
        id: "u-owner",
        name: "Owner",
        email: "owner@example.com",
        avatar: null,
        type: "human",
      },
    });
    useWorkspacesStore.setState({
      workspaces: [
        {
          id: "ws-1",
          name: "Workspace",
          role: "owner",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "ws-2",
          name: "Other Workspace",
          role: "member",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const cleanup = registerGlobalWsHandlers(() => {});

    wsEvents.emit("ws:member_role_changed", {
      workspaceId: "ws-2",
      userId: "u-owner",
      newRole: "admin",
    });

    expect(
      useWorkspacesStore.getState().workspaces.find((workspace) => workspace.id === "ws-2")
        ?.role,
    ).toBe("admin");
    expect(useWorkspacesStore.getState().activeWorkspace?.id).toBe("ws-1");
    cleanup();
  });

  it("updates both workspace-list and active-member roles after demotion", () => {
    useAuthStore.setState({
      token: "token-1",
      loading: false,
      user: {
        id: "u-owner",
        name: "Owner",
        email: "owner@example.com",
        avatar: null,
        type: "human",
      },
    });
    useWorkspacesStore.setState({
      workspaces: [
        {
          id: "ws-1",
          name: "Workspace",
          role: "owner",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const cleanup = registerGlobalWsHandlers(() => {});

    wsEvents.emit("ws:member_role_changed", {
      workspaceId: "ws-1",
      userId: "u-owner",
      newRole: "member",
    });

    expect(useWorkspacesStore.getState().workspaces[0]?.role).toBe("member");
    expect(
      useWorkspacesStore
        .getState()
        .activeWorkspace?.members.find((member) => member.userId === "u-owner")?.role,
    ).toBe("member");
    cleanup();
  });

  it("updates an active workspace member name and profile picture", () => {
    useWorkspacesStore.setState({
      activeWorkspace: {
        ...structuredClone(baseWorkspace),
        members: [
          ...structuredClone(baseWorkspace.members),
          {
            userId: "u-bot",
            role: "member",
            joinedAt: "2026-01-02T00:00:00.000Z",
            user: {
              id: "u-bot",
              name: "Old Bot Name",
              email: null,
              avatar: null,
              type: "bot",
            },
          },
        ],
      },
    });
    const cleanup = registerGlobalWsHandlers(() => {});

    wsEvents.emit("ws:member_updated", {
      workspaceId: "ws-1",
      userId: "u-bot",
      name: "Renamed Bot",
      avatar: "data:image/jpeg;base64,dXBkYXRlZA==",
    });

    expect(
      useWorkspacesStore
        .getState()
        .activeWorkspace?.members.find((member) => member.userId === "u-bot")?.user,
    ).toMatchObject({
      name: "Renamed Bot",
      avatar: "data:image/jpeg;base64,dXBkYXRlZA==",
    });

    wsEvents.emit("ws:member_updated", {
      workspaceId: "ws-1",
      userId: "u-bot",
      name: "Renamed Bot",
      avatar: null,
    });
    expect(
      useWorkspacesStore
        .getState()
        .activeWorkspace?.members.find((member) => member.userId === "u-bot")?.user.avatar,
    ).toBeNull();

    useAuthStore.setState({
      user: structuredClone(baseWorkspace.members[0]!.user),
    });
    wsEvents.emit("ws:member_updated", {
      workspaceId: "ws-1",
      userId: "u-owner",
      name: "Updated Owner",
      avatar: "data:image/jpeg;base64,b3duZXI=",
    });
    expect(useAuthStore.getState().user).toMatchObject({
      name: "Updated Owner",
      avatar: "data:image/jpeg;base64,b3duZXI=",
    });
    cleanup();
  });

  it("fires direct-message notifications with a stable message dedupe key", () => {
    useAuthStore.setState({
      token: "token-1",
      user: {
        id: "u-current",
        name: "Current User",
        email: "current@example.com",
        avatar: null,
        type: "human",
      },
      loading: false,
    });
    const cleanup = registerGlobalWsHandlers(() => {});

    wsEvents.emit("ws:new_message", {
      conversationType: "direct",
      message: {
        id: "msg-1",
        conversationId: "conv-1",
        threadId: null,
        senderId: "u-other",
        senderName: "Other User",
        content: "hello",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });

    expect(fireNotification).toHaveBeenCalledWith("Other User", "hello", {
      dedupeKey: "message:msg-1",
    });

    cleanup();
  });

  it("hydrates a cached empty background DM from the global message event", () => {
    useAuthStore.setState({
      token: "token-1",
      user: {
        id: "u-current",
        name: "Current User",
        email: "current@example.com",
        avatar: null,
        type: "human",
      },
      loading: false,
    });
    const client = new QueryClient();
    const key = ["messages", "conv-1", "all"] as const;
    client.setQueryData(key, {
      pages: [{ messages: [], hasOlder: false }],
      pageParams: [null],
    });
    const cleanup = registerGlobalWsHandlers(() => {}, () => "/", client);
    const message = {
      id: "msg-background",
      conversationId: "conv-1",
      threadId: null,
      senderId: "u-other",
      senderName: "Other User",
      senderType: "human" as const,
      content: "arrived while the DM was closed",
      parts: null,
      attachments: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    try {
      wsEvents.emit("ws:new_message", {
        conversationType: "direct",
        message,
      });

      expect(
        client.getQueryData<{
          pages: Array<{ messages: Array<typeof message>; hasOlder: boolean }>;
          pageParams: Array<string | null>;
        }>(key)?.pages[0].messages,
      ).toEqual([message]);
    } finally {
      cleanup();
      client.clear();
    }
  });

  it("does not fire direct-message notifications for the current user's messages", () => {
    useAuthStore.setState({
      token: "token-1",
      user: {
        id: "u-current",
        name: "Current User",
        email: "current@example.com",
        avatar: null,
        type: "human",
      },
      loading: false,
    });
    const cleanup = registerGlobalWsHandlers(() => {});

    wsEvents.emit("ws:new_message", {
      conversationType: "direct",
      message: {
        id: "msg-1",
        conversationId: "conv-1",
        threadId: null,
        senderId: "u-current",
        senderName: "Current User",
        content: "hello",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });

    expect(fireNotification).not.toHaveBeenCalled();
    expect(useHermesIndicatorsStore.getState().unreadScopes).toEqual({});

    cleanup();
  });

  it("does not mark the current user's group message unread", () => {
    useAuthStore.setState({
      token: "token-1",
      user: {
        id: "u-current",
        name: "Current User",
        email: "current@example.com",
        avatar: null,
        type: "human",
      },
      loading: false,
    });
    const cleanup = registerGlobalWsHandlers(() => {}, () => "/channel/ch-other");

    wsEvents.emit("ws:new_message", {
      conversationType: "group",
      message: {
        id: "msg-self",
        conversationId: "ch-active",
        threadId: null,
        senderId: "u-current",
        senderName: "Current User",
        content: "hello",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });

    expect(useConversationsStore.getState().unreadChannels).toEqual(new Set());

    cleanup();
  });

  it("marks another user's group message unread only for a background channel", () => {
    useAuthStore.setState({
      token: "token-1",
      user: {
        id: "u-current",
        name: "Current User",
        email: "current@example.com",
        avatar: null,
        type: "human",
      },
      loading: false,
    });
    const path = "/channel/ch-active";
    const cleanup = registerGlobalWsHandlers(() => {}, () => path);

    wsEvents.emit("ws:new_message", {
      conversationType: "group",
      message: {
        id: "msg-visible",
        conversationId: "ch-active",
        threadId: null,
        senderId: "u-other",
        senderName: "Other User",
        content: "visible",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(useConversationsStore.getState().unreadChannels).toEqual(new Set());

    wsEvents.emit("ws:new_message", {
      conversationType: "group",
      message: {
        id: "msg-background",
        conversationId: "ch-background",
        threadId: null,
        senderId: "u-other",
        senderName: "Other User",
        content: "background",
        createdAt: "2026-01-01T00:01:00.000Z",
      },
    });
    expect(useConversationsStore.getState().unreadChannels).toEqual(
      new Set(["ch-background"]),
    );

    cleanup();
  });

  it("dedupes workspace invite OS notifications by invite id", () => {
    const cleanup = registerGlobalWsHandlers(() => {});

    wsEvents.emit("ws:invite_received", {
      invite: {
        id: "invite-1",
        workspaceId: "ws-1",
        workspaceName: "Workspace",
        inviterId: "u-owner",
        inviterName: "Owner",
        inviteeId: "u-current",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });

    expect(fireNotification).toHaveBeenCalledWith(
      "Workspace Invite",
      "Owner invited you to Workspace",
      { dedupeKey: "workspace-invite:invite-1" },
    );
    expect(useNotificationsStore.getState().notifications).toHaveLength(1);

    cleanup();
  });

  it("reconciles channel state from the server after websocket authentication", async () => {
    const recovered: WorkspaceChannel = {
      id: "ch-recovered",
      workspaceId: "ws-1",
      name: "recovered",
      title: "Recovered",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    workspacesGetMock.mockResolvedValueOnce({
      data: { ...baseWorkspace, channels: [recovered] },
      error: null,
    });
    const cleanup = registerGlobalWsHandlers(() => {});

    wsEvents.emit("ws:authenticated", {});

    await vi.waitFor(() => {
      expect(
        useWorkspacesStore.getState().activeWorkspace?.channels,
      ).toEqual([recovered]);
    });
    expect(workspacesRouteMock).toHaveBeenCalledWith({ id: "ws-1" });
    expect(
      useNotificationsStore.getState().fetchNotifications,
    ).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("applies channel lifecycle events idempotently and reroutes a deleted active channel", () => {
    const general: WorkspaceChannel = {
      id: "ch-general",
      workspaceId: "ws-1",
      name: "general",
      title: "General",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const product: WorkspaceChannel = {
      ...general,
      id: "ch-product",
      name: "product",
      title: "Product",
    };
    useWorkspacesStore.setState({
      activeWorkspace: { ...structuredClone(baseWorkspace), channels: [general] },
    });
    useConversationsStore.setState({
      unreadChannels: new Set([general.id]),
    });
    window.location.hash = `#/channel/${general.id}`;
    const navigate = vi.fn(({ to }: { to: string }) => {
      window.location.hash = `#${to}`;
    });
    const cleanup = registerGlobalWsHandlers(navigate);

    wsEvents.emit("ws:channel_created", {
      workspaceId: "ws-1",
      channel: product,
    });
    wsEvents.emit("ws:channel_created", {
      workspaceId: "ws-1",
      channel: product,
    });
    expect(
      useWorkspacesStore.getState().activeWorkspace?.channels.map((channel) =>
        channel.id,
      ),
    ).toEqual([general.id, product.id]);

    const renamedProduct = {
      ...product,
      name: "product-updates",
      title: "Product Updates",
    };
    wsEvents.emit("ws:channel_renamed", {
      workspaceId: "ws-1",
      channel: renamedProduct,
    });
    expect(
      useWorkspacesStore.getState().activeWorkspace?.channels[1],
    ).toEqual(renamedProduct);

    wsEvents.emit("ws:channel_deleted", {
      workspaceId: "ws-1",
      channelId: general.id,
    });
    expect(
      useWorkspacesStore.getState().activeWorkspace?.channels,
    ).toEqual([renamedProduct]);
    expect(useConversationsStore.getState().unreadChannels.has(general.id)).toBe(
      false,
    );
    expect(navigate).toHaveBeenCalledWith({ to: `/channel/${product.id}` });

    wsEvents.emit("ws:channel_renamed", {
      workspaceId: "ws-1",
      channel: { ...general, name: "late-rename", title: "Late Rename" },
    });
    wsEvents.emit("ws:channel_created", {
      workspaceId: "ws-1",
      channel: general,
    });
    wsEvents.emit("ws:channel_renamed", {
      workspaceId: "ws-1",
      channel: {
        ...product,
        id: "ch-never-created",
        name: "never-created",
        title: "Never Created",
      },
    });
    expect(
      useWorkspacesStore.getState().activeWorkspace?.channels,
    ).toEqual([renamedProduct]);

    cleanup();
    window.location.hash = "";
    wsEvents.emit("ws:channel_created", {
      workspaceId: "ws-1",
      channel: { ...product, id: "ch-after-cleanup" },
    });
    expect(
      useWorkspacesStore.getState().activeWorkspace?.channels,
    ).toEqual([renamedProduct]);
  });

  it("feeds Hermes invocation progress lifecycle events into the indicators store", () => {
    useHermesIndicatorsStore.getState().resetForTests();
    const invocation: BotInvocationPublic = {
      id: "inv-1",
      botId: "bot-1",
      botUserId: "u-bot",
      botName: "Hermes",
      botKind: "hermes",
      conversationId: "conv-1",
      threadId: "t-1",
      triggerMessageId: "msg-1",
      responseMessageId: null,
      adapterKind: "hermes",
      status: "claimed",
      externalRunId: null,
      requestJson: null,
      responseJson: null,
      error: null,
      startedAt: "2026-06-11T10:00:00.000Z",
      completedAt: "2026-06-11T10:00:00.000Z",
      createdAt: "2026-06-11T10:00:00.000Z",
      updatedAt: "2026-06-11T10:00:00.000Z",
    };
    const approvalRequest: BotInvocationProgressEventPublic = {
      id: "evt-1",
      invocationId: "inv-1",
      botId: "bot-1",
      conversationId: "conv-1",
      threadId: "t-1",
      sequence: 1,
      type: "approval.request",
      status: null,
      toolCallId: null,
      toolName: null,
      label: null,
      preview: null,
      payload: null,
      occurredAt: "2026-06-11T10:01:00.000Z",
      createdAt: "2026-06-11T10:01:00.000Z",
    };

    const cleanup = registerGlobalWsHandlers(() => {});

    wsEvents.emit("ws:bot_invocation_progress", {
      conversationId: "conv-1",
      invocationId: "inv-1",
      event: approvalRequest,
      invocation,
    });

    expect(
      useHermesIndicatorsStore.getState().pendingApprovals.map((p) => p.eventId),
    ).toEqual(["evt-1"]);

    const completedInvocation = {
      ...invocation,
      responseJson: { completion: { type: "silent" } },
    };
    wsEvents.emit("ws:bot_invocation_updated", {
      conversationId: "conv-1",
      invocation: completedInvocation,
    });

    wsEvents.emit("ws:bot_invocation_progress", {
      conversationId: "conv-1",
      invocationId: "inv-1",
      event: {
        ...approvalRequest,
        id: "evt-terminal",
        sequence: 2,
        type: "invocation.completed",
        status: "completed",
      },
      invocation,
    });

    const state = useHermesIndicatorsStore.getState();
    expect(state.pendingApprovals).toEqual([]);
    expect(state.unreadScopes[hermesScopeKey("conv-1", "t-1")]).toBeDefined();

    cleanup();
  });
});
