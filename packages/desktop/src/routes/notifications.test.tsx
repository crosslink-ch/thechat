import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BotWorkspaceInvite, WorkspaceInvite } from "@thechat/shared";
import { NotificationsRoute } from "./notifications";
import { useNotificationsStore } from "../stores/notifications";

const botInvite: BotWorkspaceInvite = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "workspace-alpha",
  workspaceName: "Workspace Alpha",
  botId: "22222222-2222-4222-8222-222222222222",
  botName: "External Helper",
  requesterId: "33333333-3333-4333-8333-333333333333",
  requesterName: "Rita Requester",
  status: "pending",
  createdAt: "2026-08-04T00:00:00.000Z",
};

const workspaceInvite: WorkspaceInvite = {
  id: "44444444-4444-4444-8444-444444444444",
  workspaceId: "workspace-beta",
  workspaceName: "Workspace Beta",
  inviterId: "55555555-5555-4555-8555-555555555555",
  inviterName: "Ivan Inviter",
  createdAt: "2026-08-04T00:00:00.000Z",
};

beforeEach(() => {
  useNotificationsStore.setState(useNotificationsStore.getInitialState(), true);
});

describe("NotificationsRoute", () => {
  it("lets a bot owner approve a workspace request", async () => {
    const user = userEvent.setup();
    const approve = vi.fn().mockResolvedValue(undefined);
    useNotificationsStore.setState({
      notifications: [{ type: "bot_workspace_invite", invite: botInvite }],
      loading: false,
      error: null,
      acceptBotWorkspaceInvite: approve,
    });

    render(<NotificationsRoute />);

    expect(
      screen.getByText("Add External Helper to Workspace Alpha"),
    ).toBeVisible();
    expect(screen.getByText(/Rita Requester wants to add a bot you own/)).toBeVisible();
    expect(screen.getByText(`Bot ID: ${botInvite.botId}`)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith(botInvite.id));
  });

  it("keeps the existing user invitation flow", async () => {
    const user = userEvent.setup();
    const accept = vi.fn().mockResolvedValue(undefined);
    useNotificationsStore.setState({
      notifications: [{ type: "workspace_invite", invite: workspaceInvite }],
      loading: false,
      error: null,
      acceptInvite: accept,
    });

    render(<NotificationsRoute />);

    expect(screen.getByText("Join Workspace Beta")).toBeVisible();
    expect(screen.getByText(/Ivan Inviter invited you/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(accept).toHaveBeenCalledWith(workspaceInvite.id));
  });
});
