import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  Bot,
  BotWorkspaceInvite,
  WorkspaceWithDetails,
} from "@thechat/shared";
import { WorkspaceManageRoute } from "./workspace-manage";
import { useAuthStore } from "../stores/auth";
import { useWorkspacesStore } from "../stores/workspaces";

const apiMocks = vi.hoisted(() => {
  const workspaceGet = vi.fn();
  const updateRole = vi.fn();
  const removeMember = vi.fn();
  const addBot = vi.fn();
  const removeBot = vi.fn();
  const listBotInvites = vi.fn();
  const cancelBotInvite = vi.fn();
  const inviteUser = vi.fn();
  const listBots = vi.fn();

  const members = vi.fn(() => ({
    role: { post: updateRole },
    delete: removeMember,
  }));
  const bots = Object.assign(
    vi.fn(() => ({ delete: removeBot })),
    { post: addBot },
  );
  const botInvites = Object.assign(
    vi.fn(() => ({ delete: cancelBotInvite })),
    { get: listBotInvites },
  );
  const workspaces = vi.fn(() => ({
    get: workspaceGet,
    members,
    bots,
    "bot-invites": botInvites,
  }));

  return {
    workspaceGet,
    updateRole,
    removeMember,
    addBot,
    removeBot,
    listBotInvites,
    cancelBotInvite,
    inviteUser,
    listBots,
    workspaces,
  };
});

vi.mock("../lib/api", () => ({
  api: {
    workspaces: apiMocks.workspaces,
    invites: { create: { post: apiMocks.inviteUser } },
    bots: { list: { get: apiMocks.listBots } },
  },
}));

const ownerUser = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Olivia Owner",
  email: "owner@example.com",
  avatar: null,
  type: "human" as const,
};

const memberUser = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Mina Member",
  email: "member@example.com",
  avatar: null,
  type: "human" as const,
};

const workspaceBotId = "33333333-3333-4333-8333-333333333333";
const ownedBotId = "44444444-4444-4444-8444-444444444444";

const workspace: WorkspaceWithDetails = {
  id: "workspace-alpha-a1b2",
  name: "Workspace Alpha",
  createdAt: "2026-08-04T00:00:00.000Z",
  updatedAt: "2026-08-04T00:00:00.000Z",
  channels: [],
  members: [
    {
      userId: ownerUser.id,
      role: "owner",
      joinedAt: "2026-08-04T00:00:00.000Z",
      user: ownerUser,
      bot: null,
    },
    {
      userId: memberUser.id,
      role: "member",
      joinedAt: "2026-08-04T00:00:00.000Z",
      user: memberUser,
      bot: null,
    },
    {
      userId: "55555555-5555-4555-8555-555555555555",
      role: "member",
      joinedAt: "2026-08-04T00:00:00.000Z",
      user: {
        id: "55555555-5555-4555-8555-555555555555",
        name: "Workspace Helper",
        email: null,
        avatar: null,
        type: "bot",
      },
      bot: { id: workspaceBotId, kind: "webhook" },
    },
  ],
};

const ownedBot: Bot = {
  id: ownedBotId,
  userId: "66666666-6666-4666-8666-666666666666",
  name: "My Helper",
  kind: "webhook",
  webhookUrl: null,
  createdAt: "2026-08-04T00:00:00.000Z",
};

function setWorkspace(activeWorkspace = workspace) {
  useAuthStore.setState({ user: ownerUser, token: "test-token", loading: false });
  useWorkspacesStore.setState({
    workspaces: [
      {
        id: activeWorkspace.id,
        name: activeWorkspace.name,
        role: "owner",
        createdAt: activeWorkspace.createdAt,
        updatedAt: activeWorkspace.updatedAt,
      },
    ],
    activeWorkspace,
    loading: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setWorkspace();
  apiMocks.workspaceGet.mockResolvedValue({ data: workspace, error: null });
  apiMocks.listBots.mockResolvedValue({ data: [ownedBot], error: null });
  apiMocks.listBotInvites.mockResolvedValue({ data: [], error: null });
  apiMocks.inviteUser.mockResolvedValue({ data: { id: "invite-1" }, error: null });
  apiMocks.updateRole.mockResolvedValue({ data: { success: true }, error: null });
  apiMocks.removeMember.mockResolvedValue({ data: { success: true }, error: null });
  apiMocks.addBot.mockResolvedValue({
    data: { status: "added", botId: ownedBotId },
    error: null,
  });
  apiMocks.removeBot.mockResolvedValue({ data: { success: true }, error: null });
  apiMocks.cancelBotInvite.mockResolvedValue({
    data: { success: true },
    error: null,
  });
});

describe("WorkspaceManageRoute", () => {
  it("shows the workspace ID, people and bots instead of LLM configuration", async () => {
    render(<WorkspaceManageRoute />);

    expect(await screen.findByTestId("workspace-id")).toHaveTextContent(
      workspace.id,
    );
    expect(screen.getByText("Olivia Owner")).toBeInTheDocument();
    expect(screen.getByText("Mina Member")).toBeInTheDocument();
    expect(screen.getByText("Workspace Helper")).toBeInTheDocument();
    expect(screen.queryByText(/OpenRouter/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/LLM provider/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/API key/i)).not.toBeInTheDocument();
  });

  it("invites an existing user by email", async () => {
    const user = userEvent.setup();
    render(<WorkspaceManageRoute />);
    await screen.findByTestId("workspace-id");

    await user.type(screen.getByTestId("invite-user-email"), "new@example.com");
    await user.click(screen.getByTestId("invite-user-submit"));

    await waitFor(() => {
      expect(apiMocks.inviteUser).toHaveBeenCalledWith(
        { workspaceId: workspace.id, email: "new@example.com" },
        { headers: { authorization: "Bearer test-token" } },
      );
    });
    expect(await screen.findByText("Invitation sent to new@example.com.")).toBeVisible();
  });

  it("adds an owned bot immediately", async () => {
    const user = userEvent.setup();
    render(<WorkspaceManageRoute />);
    await screen.findByTestId("workspace-id");

    await user.type(screen.getByTestId("bot-id-input"), ownedBotId);
    await user.click(screen.getByTestId("add-bot-submit"));

    await waitFor(() => {
      expect(apiMocks.addBot).toHaveBeenCalledWith(
        { botId: ownedBotId },
        { headers: { authorization: "Bearer test-token" } },
      );
    });
    expect(await screen.findByText("Bot added to the workspace.")).toBeVisible();
  });

  it("shows a pending row when a non-owned bot needs approval", async () => {
    const user = userEvent.setup();
    const invite: BotWorkspaceInvite = {
      id: "77777777-7777-4777-8777-777777777777",
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      botId: "88888888-8888-4888-8888-888888888888",
      botName: "External Helper",
      requesterId: ownerUser.id,
      requesterName: ownerUser.name,
      status: "pending",
      createdAt: "2026-08-04T00:00:00.000Z",
    };
    apiMocks.addBot.mockResolvedValue({
      data: { status: "pending", invite },
      error: null,
    });
    apiMocks.listBotInvites
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValue({ data: [invite], error: null });

    render(<WorkspaceManageRoute />);
    await screen.findByTestId("workspace-id");
    await user.type(screen.getByTestId("bot-id-input"), invite.botId);
    await user.click(screen.getByTestId("add-bot-submit"));

    expect(
      await screen.findByText("Approval requested from the owner of External Helper."),
    ).toBeVisible();
    expect(await screen.findByTestId(`pending-bot-request-${invite.id}`)).toHaveTextContent(
      "The bot owner has been notified",
    );
  });

  it("updates roles and removes people with confirmation", async () => {
    const user = userEvent.setup();
    render(<WorkspaceManageRoute />);
    const memberRow = await screen.findByTestId(`member-row-${memberUser.id}`);

    await user.selectOptions(
      within(memberRow).getByRole("combobox", { name: `Role for ${memberUser.name}` }),
      "admin",
    );
    await waitFor(() => {
      expect(apiMocks.updateRole).toHaveBeenCalledWith(
        { role: "admin" },
        { headers: { authorization: "Bearer test-token" } },
      );
    });

    await user.click(within(memberRow).getByRole("button", { name: "Remove" }));
    await user.click(within(memberRow).getByRole("button", { name: "Confirm" }));
    await waitFor(() => {
      expect(apiMocks.removeMember).toHaveBeenCalledWith(undefined, {
        headers: { authorization: "Bearer test-token" },
      });
    });
  });

  it("is read-only for regular members", async () => {
    const memberWorkspace: WorkspaceWithDetails = {
      ...workspace,
      members: workspace.members.map((member) =>
        member.userId === ownerUser.id ? { ...member, role: "member" } : member,
      ),
    };
    setWorkspace(memberWorkspace);
    apiMocks.workspaceGet.mockResolvedValue({ data: memberWorkspace, error: null });

    render(<WorkspaceManageRoute />);

    expect(
      await screen.findByText(/Only workspace owners and admins can make changes/),
    ).toBeVisible();
    expect(screen.queryByTestId("invite-user-email")).not.toBeInTheDocument();
    expect(screen.queryByTestId("bot-id-input")).not.toBeInTheDocument();
    expect(apiMocks.listBots).not.toHaveBeenCalled();
  });
});
