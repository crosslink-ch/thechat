import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivitySnapshot, ChatMessage } from "@thechat/shared";
import { useAuthStore } from "./auth";
import { useActivityStore } from "./activity";
import { useConversationsStore } from "./conversations";

const {
  activityGet,
  conversationReadPost,
  conversationsRoute,
  readAllPost,
} = vi.hoisted(() => ({
  activityGet: vi.fn(),
  conversationReadPost: vi.fn(),
  conversationsRoute: vi.fn(),
  readAllPost: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api: {
    activity: {
      get: activityGet,
      conversations: conversationsRoute,
      "read-all": { post: readAllPost },
    },
  },
}));

const unreadSnapshot: ActivitySnapshot = {
  totalUnreadMessages: 3,
  items: [
    {
      conversationId: "conversation-1",
      conversationType: "group",
      conversationName: "General",
      workspaceId: "workspace-2",
      workspaceName: "Beta",
      unreadCount: 3,
      latestMessage: {
        id: "message-3",
        threadId: null,
        threadTitle: null,
        senderId: "user-2",
        senderName: "Alice",
        senderType: "human",
        content: "Latest update",
        createdAt: "2026-09-01T10:00:00.000Z",
      },
    },
  ],
};

const emptySnapshot: ActivitySnapshot = {
  items: [],
  totalUnreadMessages: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  conversationsRoute.mockReturnValue({
    read: { post: conversationReadPost },
  });
  activityGet.mockResolvedValue({ data: unreadSnapshot, error: null });
  conversationReadPost.mockResolvedValue({ data: emptySnapshot, error: null });
  readAllPost.mockResolvedValue({ data: emptySnapshot, error: null });
  useAuthStore.setState({ token: "token-1", user: null, loading: false });
  useActivityStore.getState().reset();
  useConversationsStore.setState({
    unreadChannels: new Set(),
    unreadDirectConversations: {},
  });
});

describe("activity store", () => {
  it("hydrates persisted unread activity from the server", async () => {
    await useActivityStore.getState().fetchActivity();

    expect(activityGet).toHaveBeenCalledWith({
      headers: { authorization: "Bearer token-1" },
    });
    expect(useActivityStore.getState()).toMatchObject(unreadSnapshot);
    expect(useConversationsStore.getState().unreadChannels).toEqual(
      new Set(["conversation-1"]),
    );
  });

  it("persists rendered message IDs and applies the returned snapshot", async () => {
    useActivityStore.setState(unreadSnapshot);
    useConversationsStore.setState({
      unreadChannels: new Set(["conversation-1"]),
    });

    await useActivityStore
      .getState()
      .markConversationRead("conversation-1", ["message-3"]);

    expect(conversationsRoute).toHaveBeenCalledWith({
      conversationId: "conversation-1",
    });
    expect(conversationReadPost).toHaveBeenCalledWith(
      { messageIds: ["message-3"] },
      { headers: { authorization: "Bearer token-1" } },
    );
    expect(useActivityStore.getState()).toMatchObject(emptySnapshot);
    expect(useConversationsStore.getState().unreadChannels.size).toBe(0);
  });

  it("explicitly clears a whole conversation from Activity", async () => {
    await useActivityStore
      .getState()
      .markConversationRead("conversation-1");

    expect(conversationReadPost).toHaveBeenCalledWith(
      { all: true },
      { headers: { authorization: "Bearer token-1" } },
    );
  });

  it("reconciles a visible live message so hidden threads cannot go stale", async () => {
    const message: ChatMessage = {
      id: "message-live",
      conversationId: "conversation-1",
      threadId: null,
      senderId: "user-2",
      senderName: "Alice",
      senderType: "human",
      content: "Visible message",
      createdAt: "2026-09-01T10:01:00.000Z",
    };

    await useActivityStore.getState().handleIncomingMessage(message, true);

    expect(conversationReadPost).not.toHaveBeenCalled();
    expect(activityGet).toHaveBeenCalledTimes(1);
    expect(useActivityStore.getState()).toMatchObject(unreadSnapshot);
  });

  it("reconciles a background live message from the server", async () => {
    const message: ChatMessage = {
      id: "message-background",
      conversationId: "conversation-1",
      threadId: null,
      senderId: "user-2",
      senderName: "Alice",
      senderType: "human",
      content: "Background message",
      createdAt: "2026-09-01T10:02:00.000Z",
    };

    await useActivityStore.getState().handleIncomingMessage(message, false);

    expect(activityGet).toHaveBeenCalledTimes(1);
    expect(conversationReadPost).not.toHaveBeenCalled();
    expect(useActivityStore.getState()).toMatchObject(unreadSnapshot);
  });

  it("does not let an older mutation response overwrite a newer one", async () => {
    activityGet.mockResolvedValue({ data: emptySnapshot, error: null });
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    conversationReadPost
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          resolveSecond = resolve;
        }),
      );

    const first = useActivityStore
      .getState()
      .markConversationRead("conversation-1", ["message-1"]);
    const second = useActivityStore
      .getState()
      .markConversationRead("conversation-2", ["message-2"]);

    resolveSecond({ data: emptySnapshot, error: null });
    await second;
    resolveFirst({ data: unreadSnapshot, error: null });
    await first;

    expect(useActivityStore.getState()).toMatchObject(emptySnapshot);
  });

  it("does not let a fetch started during a mutation restore stale unread state", async () => {
    let resolveMutation!: (value: unknown) => void;
    let resolveFetch!: (value: unknown) => void;
    conversationReadPost.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveMutation = resolve;
      }),
    );
    activityGet
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          resolveFetch = resolve;
        }),
      )
      .mockResolvedValueOnce({ data: emptySnapshot, error: null });

    const mutation = useActivityStore
      .getState()
      .markConversationRead("conversation-1", ["message-1"]);
    const fetch = useActivityStore.getState().fetchActivity();

    resolveMutation({ data: emptySnapshot, error: null });
    await mutation;
    resolveFetch({ data: unreadSnapshot, error: null });
    await fetch;

    await vi.waitFor(() => {
      expect(activityGet).toHaveBeenCalledTimes(2);
      expect(useActivityStore.getState()).toMatchObject(emptySnapshot);
    });
  });

  it("does not let an older mutation response overwrite a newer fetch", async () => {
    let resolveMutation!: (value: unknown) => void;
    let resolveFetch!: (value: unknown) => void;
    conversationReadPost.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveMutation = resolve;
      }),
    );
    activityGet
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          resolveFetch = resolve;
        }),
      )
      .mockResolvedValueOnce({ data: unreadSnapshot, error: null });

    const mutation = useActivityStore
      .getState()
      .markConversationRead("conversation-1", ["message-1"]);
    const fetch = useActivityStore.getState().fetchActivity();

    resolveFetch({ data: unreadSnapshot, error: null });
    await fetch;
    expect(useActivityStore.getState()).toMatchObject(unreadSnapshot);

    resolveMutation({ data: emptySnapshot, error: null });
    await mutation;

    await vi.waitFor(() => {
      expect(activityGet).toHaveBeenCalledTimes(2);
      expect(useActivityStore.getState()).toMatchObject(unreadSnapshot);
    });
  });

  it("marks all unread activity as read on the server", async () => {
    useActivityStore.setState(unreadSnapshot);

    await useActivityStore.getState().markAllRead();

    expect(readAllPost).toHaveBeenCalledWith(
      {},
      { headers: { authorization: "Bearer token-1" } },
    );
    expect(useActivityStore.getState()).toMatchObject(emptySnapshot);
  });
});
