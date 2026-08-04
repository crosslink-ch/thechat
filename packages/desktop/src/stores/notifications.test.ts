import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BotWorkspaceInvite, WorkspaceInvite } from "@thechat/shared";
import { useAuthStore } from "./auth";
import { useNotificationsStore } from "./notifications";

const {
  workspacePendingGet,
  workspaceAcceptPost,
  workspaceDeclinePost,
  botPendingGet,
  botAcceptPost,
  botDeclinePost,
} = vi.hoisted(() => ({
  workspacePendingGet: vi.fn(),
  workspaceAcceptPost: vi.fn(),
  workspaceDeclinePost: vi.fn(),
  botPendingGet: vi.fn(),
  botAcceptPost: vi.fn(),
  botDeclinePost: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api: {
    invites: {
      pending: { get: workspacePendingGet },
      accept: { post: workspaceAcceptPost },
      decline: { post: workspaceDeclinePost },
    },
    "bot-workspace-invites": {
      pending: { get: botPendingGet },
      accept: { post: botAcceptPost },
      decline: { post: botDeclinePost },
    },
  },
}));

const workspaceInvite: WorkspaceInvite = {
  id: "workspace-invite-1",
  workspaceId: "workspace-1",
  workspaceName: "Workspace One",
  inviterId: "user-2",
  inviterName: "Inviter",
  createdAt: "2026-08-04T00:00:00.000Z",
};

const botInvite: BotWorkspaceInvite = {
  id: "bot-invite-1",
  workspaceId: "workspace-1",
  workspaceName: "Workspace One",
  botId: "bot-1",
  botName: "Helper",
  requesterId: "user-2",
  requesterName: "Requester",
  status: "pending",
  createdAt: "2026-08-04T00:00:00.000Z",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function treatyError(status: number, message: string) {
  const error = new Error(message) as Error & {
    status: number;
    value: { error: string };
  };
  error.status = status;
  error.value = { error: message };
  return error;
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ token: "token-1", user: null, loading: false });
  useNotificationsStore.getState().reset();
  workspacePendingGet.mockResolvedValue({ data: [], error: null });
  botPendingGet.mockResolvedValue({ data: [], error: null });
  workspaceAcceptPost.mockResolvedValue({ data: { success: true }, error: null });
  workspaceDeclinePost.mockResolvedValue({ data: { success: true }, error: null });
  botAcceptPost.mockResolvedValue({ data: { success: true }, error: null });
  botDeclinePost.mockResolvedValue({ data: { success: true }, error: null });
});

describe("notifications store reconciliation", () => {
  it("refetches instead of overwriting a realtime notification with a stale response", async () => {
    const firstWorkspaceFetch = deferred<{ data: WorkspaceInvite[]; error: null }>();
    workspacePendingGet
      .mockReturnValueOnce(firstWorkspaceFetch.promise)
      .mockResolvedValueOnce({ data: [], error: null });
    botPendingGet
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: [botInvite], error: null });

    const firstFetch = useNotificationsStore.getState().fetchNotifications();
    useNotificationsStore.getState().addNotification({
      type: "bot_workspace_invite",
      invite: botInvite,
    });
    firstWorkspaceFetch.resolve({ data: [workspaceInvite], error: null });
    await firstFetch;

    await vi.waitFor(() => {
      expect(workspacePendingGet).toHaveBeenCalledTimes(2);
      expect(useNotificationsStore.getState().notifications).toEqual([
        { type: "bot_workspace_invite", invite: botInvite },
      ]);
      expect(useNotificationsStore.getState().loading).toBe(false);
    });
  });

  it("clears loading and records a transport failure", async () => {
    workspacePendingGet.mockRejectedValueOnce(new Error("offline"));

    await useNotificationsStore.getState().fetchNotifications();

    expect(useNotificationsStore.getState()).toMatchObject({
      loading: false,
      error: "offline",
    });
  });

  it("uses the real Eden approval action and removes the approved request", async () => {
    useNotificationsStore.setState({
      notifications: [{ type: "bot_workspace_invite", invite: botInvite }],
    });

    await useNotificationsStore
      .getState()
      .acceptBotWorkspaceInvite(botInvite.id);

    expect(botAcceptPost).toHaveBeenCalledWith(
      { inviteId: botInvite.id },
      { headers: { authorization: "Bearer token-1" } },
    );
    expect(useNotificationsStore.getState().notifications).toEqual([]);
  });

  it("reconciles a terminal action conflict instead of retaining a stale card", async () => {
    useNotificationsStore.setState({
      notifications: [{ type: "bot_workspace_invite", invite: botInvite }],
    });
    botAcceptPost.mockResolvedValueOnce({
      data: null,
      error: treatyError(409, "Request is no longer pending"),
    });

    await expect(
      useNotificationsStore
        .getState()
        .acceptBotWorkspaceInvite(botInvite.id),
    ).rejects.toThrow("Request is no longer pending");

    expect(workspacePendingGet).toHaveBeenCalledTimes(1);
    expect(botPendingGet).toHaveBeenCalledTimes(1);
    expect(useNotificationsStore.getState().notifications).toEqual([]);
  });
});
