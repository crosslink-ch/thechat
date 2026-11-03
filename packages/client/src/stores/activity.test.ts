import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivitySnapshot, BotInvocationPublic, ChatMessage } from "@thechat/shared";
import { useAuthStore } from "./auth";
import { useActivityStore } from "./activity";
import { useConversationsStore } from "./conversations";
import { hermesScopeKey, useHermesIndicatorsStore } from "./hermes-indicators";

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

function finishSilently(id: string, threadId: string, conversationId = "conversation-1") {
  const invocation: BotInvocationPublic = {
    id, threadId, conversationId, botId: "bot", botUserId: "bot-user", botName: "Hermes", botKind: "hermes",
    triggerMessageId: "trigger", responseMessageId: null, adapterKind: "hermes", status: "queued",
    externalRunId: null, requestJson: null, responseJson: null, error: null, startedAt: null, completedAt: null,
    createdAt: "2026-11-01T10:00:00.000Z", updatedAt: "2026-11-01T10:00:00.000Z",
  };
  useHermesIndicatorsStore.getState().trackInvocation(invocation);
  useHermesIndicatorsStore.getState().trackInvocation({ ...invocation, status: "completed", responseJson: { silent: true } });
}

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
  useHermesIndicatorsStore.getState().resetForTests();
  useConversationsStore.setState({
    unreadChannels: new Set(),
    unreadDirectConversations: {},
  });
});

describe("activity store", () => {
  it("does not erase silent completion attention when fetching Activity or acknowledging rendered messages", async () => {
    finishSilently("silent", "silent-task");
    const scopes = useHermesIndicatorsStore.getState().unreadScopes;
    activityGet.mockResolvedValue({ data: emptySnapshot, error: null });
    await useActivityStore.getState().fetchActivity();
    await useActivityStore.getState().markConversationRead("conversation-1", ["rendered-message"]);
    expect(useHermesIndicatorsStore.getState().unreadScopes).toEqual(scopes);
  });

  it.each(["conversation", "all"])("preserves completion attention when explicit %s read fails", async (selection) => {
    finishSilently("silent", "silent-task");
    const scopes = useHermesIndicatorsStore.getState().unreadScopes;
    (selection === "all" ? readAllPost : conversationReadPost)
      .mockResolvedValueOnce({ data: null, error: { value: { error: "Read failed" } } });
    const pending = selection === "all"
      ? useActivityStore.getState().markAllRead()
      : useActivityStore.getState().markConversationRead("conversation-1");
    await expect(pending).rejects.toThrow("Read failed");
    expect(useHermesIndicatorsStore.getState().unreadScopes).toEqual(scopes);
  });

  it.each(["fetch", "conversation", "all"])("fences a delayed %s response after a bearer identity change", async (operation) => {
    finishSilently("silent", "silent-task");
    const scopes = useHermesIndicatorsStore.getState().unreadScopes;
    let finish!: (value: unknown) => void;
    const mock = operation === "fetch" ? activityGet : operation === "all" ? readAllPost : conversationReadPost;
    mock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = operation === "fetch" ? useActivityStore.getState().fetchActivity()
      : operation === "all" ? useActivityStore.getState().markAllRead()
      : useActivityStore.getState().markConversationRead("conversation-1");
    useAuthStore.setState({ token: "token-2" });
    finish({ data: unreadSnapshot, error: null });
    await pending;
    expect(useActivityStore.getState().items).toEqual([]);
    expect(useHermesIndicatorsStore.getState().unreadScopes).toEqual(scopes);
  });

  it.each(["conversation", "all"])("explicit %s read clears only completion attention present when requested", async (selection) => {
    finishSilently("old", "old-task");
    finishSilently("same-before", "same-task");
    finishSilently("other", "other-task", "conversation-2");
    let finish!: (value: unknown) => void;
    (selection === "all" ? readAllPost : conversationReadPost)
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = selection === "all"
      ? useActivityStore.getState().markAllRead()
      : useActivityStore.getState().markConversationRead("conversation-1");
    finishSilently("same-after", "same-task");
    finishSilently("new", "new-task");
    finish({ data: emptySnapshot, error: null });
    await pending;

    const scopes = useHermesIndicatorsStore.getState().unreadScopes;
    expect(scopes[hermesScopeKey("conversation-1", "old-task")]).toBeUndefined();
    expect(scopes[hermesScopeKey("conversation-1", "same-task")]).toBeDefined();
    expect(scopes[hermesScopeKey("conversation-1", "new-task")]).toBeDefined();
    expect(Boolean(scopes[hermesScopeKey("conversation-2", "other-task")])).toBe(selection !== "all");
  });

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
