import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
  WorkspaceWithDetails,
} from "@thechat/shared";
import { registerGlobalWsHandlers } from "./ws-global-handlers";
import { wsEvents } from "./ws-events";
import { fireNotification } from "./notifications";
import { useAuthStore } from "../stores/auth";
import { useWorkspacesStore } from "../stores/workspaces";
import { useNotificationsStore } from "../stores/notifications";
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

function hermesInvocation(
  overrides: Partial<BotInvocationPublic> = {},
): BotInvocationPublic {
  return {
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
    completedAt: null,
    createdAt: "2026-06-11T10:00:00.000Z",
    updatedAt: "2026-06-11T10:00:00.000Z",
    ...overrides,
  };
}

function hermesProgressEvent(
  overrides: Partial<BotInvocationProgressEventPublic> = {},
): BotInvocationProgressEventPublic {
  return {
    id: "evt-1",
    invocationId: "inv-1",
    botId: "bot-1",
    conversationId: "conv-1",
    threadId: "t-1",
    sequence: 1,
    type: "approval.request",
    status: null,
    toolCallId: "call-1",
    toolName: null,
    label: null,
    preview: null,
    payload: null,
    occurredAt: "2026-06-11T10:01:00.000Z",
    createdAt: "2026-06-11T10:01:00.000Z",
    ...overrides,
  };
}

describe("registerGlobalWsHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ token: "token-1", user: null, loading: false });
    useHermesIndicatorsStore.getState().resetForTests();
    useNotificationsStore.setState({ notifications: [], loading: false });
    useWorkspacesStore.setState({
      workspaces: [],
      activeWorkspace: structuredClone(baseWorkspace),
      loading: false,
    });
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

  it("feeds Hermes invocation progress lifecycle events into the indicators store", () => {
    useHermesIndicatorsStore.getState().resetForTests();
    const invocation = hermesInvocation();
    const approvalRequest = hermesProgressEvent();

    const cleanup = registerGlobalWsHandlers(() => {});

    wsEvents.emit("ws:bot_invocation_progress", {
      conversationId: "conv-1",
      invocationId: "inv-1",
      event: approvalRequest,
      invocation,
    });

    expect(useHermesIndicatorsStore.getState()).toMatchObject({
      pendingApprovals: [expect.objectContaining({ eventId: "evt-1" })],
      invocationMeta: {
        "inv-1": {
          conversationId: "conv-1",
          threadId: "t-1",
          botUserId: "u-bot",
        },
      },
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

  it("applies duplicate global progress and terminal events idempotently", () => {
    const cleanup = registerGlobalWsHandlers(() => {});
    try {
      const invocation = hermesInvocation();
      const approvalRequest = hermesProgressEvent();
      const terminal = hermesProgressEvent({
        id: "evt-terminal",
        sequence: 2,
        type: "invocation.completed",
        status: "completed",
      });

      for (let replay = 0; replay < 2; replay += 1) {
        wsEvents.emit("ws:bot_invocation_progress", {
          conversationId: "conv-1",
          invocationId: "inv-1",
          event: approvalRequest,
          invocation,
        });
      }
      expect(useHermesIndicatorsStore.getState().pendingApprovals).toEqual([
        expect.objectContaining({ eventId: "evt-1" }),
      ]);

      for (let replay = 0; replay < 2; replay += 1) {
        wsEvents.emit("ws:bot_invocation_progress", {
          conversationId: "conv-1",
          invocationId: "inv-1",
          event: terminal,
          invocation,
        });
      }

      const state = useHermesIndicatorsStore.getState();
      expect(state.pendingApprovals).toEqual([]);
      expect(state.invocationMeta).toEqual({});
      expect(state.unreadScopes).toEqual({
        [hermesScopeKey("conv-1", "t-1")]: {
          conversationId: "conv-1",
          threadId: "t-1",
          botUserId: "u-bot",
        },
      });
    } finally {
      cleanup();
    }
  });
});
