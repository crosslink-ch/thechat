import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { OwnedBot } from "@thechat/shared";

const mocks = vi.hoisted(() => ({
  listGet: vi.fn(),
  botGet: vi.fn(),
  botPatch: vi.fn(),
  botDelete: vi.fn(),
  workspacePost: vi.fn(),
  workspaceDelete: vi.fn(),
  rotateKeyPost: vi.fn(),
  revokeKeyDelete: vi.fn(),
  rotateSecretPost: vi.fn(),
  openHermesBotModal: vi.fn(),
}));

vi.mock("../lib/api", () => {
  const bots = Object.assign(
    () => ({
      get: mocks.botGet,
      patch: mocks.botPatch,
      delete: mocks.botDelete,
      workspaces: Object.assign(
        () => ({ delete: mocks.workspaceDelete }),
        { post: mocks.workspacePost },
      ),
      "regenerate-key": { post: mocks.rotateKeyPost },
      "api-key": { delete: mocks.revokeKeyDelete },
      "regenerate-secret": { post: mocks.rotateSecretPost },
    }),
    { list: { get: mocks.listGet } },
  );
  return { api: { bots } };
});

vi.mock("../components/HermesBotModal", () => ({
  openHermesBotModal: mocks.openHermesBotModal,
}));

import { BotsManageRoute } from "./bots-manage";
import { useAuthStore } from "../stores/auth";
import { useWorkspacesStore } from "../stores/workspaces";

const ownedBot: OwnedBot = {
  id: "bot-1",
  userId: "bot-user-1",
  name: "Research Bot",
  kind: "hermes",
  attachmentAccess: true,
  webhookUrl: null,
  webhookSecret: "whsec_original",
  apiKeyEnabled: true,
  workspaces: [{ id: "ws-1", name: "Primary Workspace" }],
  createdAt: "2026-08-04T10:00:00.000Z",
};

function withWorkspaces(bot: OwnedBot, workspaceIds: string[]): OwnedBot {
  const names = new Map([
    ["ws-1", "Primary Workspace"],
    ["ws-2", "Admin Workspace"],
    ["ws-3", "Member Workspace"],
  ]);
  return {
    ...bot,
    workspaces: workspaceIds.map((id) => ({ id, name: names.get(id) ?? id })),
  };
}

describe("BotsManageRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ token: "user-token", loading: false });
    useWorkspacesStore.setState({
      workspaces: [
        {
          id: "ws-1",
          name: "Primary Workspace",
          role: "owner",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "ws-2",
          name: "Admin Workspace",
          role: "admin",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "ws-3",
          name: "Member Workspace",
          role: "member",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      activeWorkspace: null,
      loading: false,
      selectWorkspace: vi.fn(),
    });
    mocks.listGet.mockResolvedValue({ data: [ownedBot], error: null });
    mocks.botGet.mockResolvedValue({ data: ownedBot, error: null });
    mocks.botPatch.mockResolvedValue({ data: ownedBot, error: null });
    mocks.botDelete.mockResolvedValue({ data: { success: true }, error: null });
    mocks.workspacePost.mockResolvedValue({ data: { success: true }, error: null });
    mocks.workspaceDelete.mockResolvedValue({ data: { success: true }, error: null });
    mocks.rotateKeyPost.mockResolvedValue({ data: { apiKey: "tc_new_api_key" }, error: null });
    mocks.revokeKeyDelete.mockResolvedValue({ data: { success: true }, error: null });
    mocks.rotateSecretPost.mockResolvedValue({
      data: { webhookSecret: "whsec_rotated" },
      error: null,
    });
  });

  it("loads owned bots without requiring an active workspace", async () => {
    expect(useWorkspacesStore.getState().activeWorkspace).toBeNull();
    render(<BotsManageRoute />);

    expect(await screen.findByRole("heading", { name: "Research Bot" })).toBeInTheDocument();
    expect(screen.getByText("Manage every bot you own, independent of the workspace currently open.")).toBeInTheDocument();
    expect(screen.getByTestId("bot-workspace-ws-1")).toHaveTextContent("Connected");
    expect(screen.getByTestId("bot-workspace-ws-2")).toHaveTextContent("admin access");
    expect(screen.getByTestId("bot-workspace-ws-3")).toHaveTextContent(
      "Workspace admin access required",
    );
    expect(screen.getByTestId("bot-workspace-ws-3").querySelector("button")).toBeDisabled();
    expect(mocks.listGet).toHaveBeenCalledOnce();
  });

  it("updates bot details", async () => {
    const renamed = { ...ownedBot, name: "Renamed Bot", attachmentAccess: false };
    mocks.botPatch.mockResolvedValue({ data: renamed, error: null });
    render(<BotsManageRoute />);
    await screen.findByDisplayValue("Research Bot");

    fireEvent.change(screen.getByLabelText("Bot name"), { target: { value: "Renamed Bot" } });
    fireEvent.click(screen.getByLabelText("Allow message attachments"));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(mocks.botPatch).toHaveBeenCalledWith(
        { name: "Renamed Bot", webhookUrl: null, attachmentAccess: false },
        expect.objectContaining({ headers: { authorization: "Bearer user-token" } }),
      );
    });
    expect(await screen.findByText("Bot details saved.")).toBeInTheDocument();
    expect(screen.getByTestId("bot-list-item-bot-1")).toHaveTextContent("Renamed Bot");
  });

  it("connects an owned bot to an admin workspace and refreshes membership", async () => {
    mocks.botGet.mockResolvedValue({
      data: withWorkspaces(ownedBot, ["ws-1", "ws-2"]),
      error: null,
    });
    render(<BotsManageRoute />);
    const row = await screen.findByTestId("bot-workspace-ws-2");

    fireEvent.click(row.querySelector("button")!);

    await waitFor(() => expect(mocks.workspacePost).toHaveBeenCalledWith(
      { workspaceId: "ws-2" },
      expect.objectContaining({ headers: { authorization: "Bearer user-token" } }),
    ));
    expect(await screen.findByText("Connected to Admin Workspace.")).toBeInTheDocument();
    expect(screen.getByTestId("bot-workspace-ws-2")).toHaveTextContent("Connected");
  });

  it("requires confirmation, then reveals a newly issued API key", async () => {
    mocks.botGet.mockResolvedValue({ data: ownedBot, error: null });
    render(<BotsManageRoute />);
    await screen.findByText("Bot API key");
    const rotateButton = screen.getAllByRole("button", { name: "Rotate" })[0];

    fireEvent.click(rotateButton);
    expect(mocks.rotateKeyPost).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm new key" }));

    expect(await screen.findByDisplayValue("tc_new_api_key")).toBeInTheDocument();
    expect(mocks.rotateKeyPost).toHaveBeenCalledOnce();
  });

  it("sends authentication as request options for bodyless delete operations", async () => {
    render(<BotsManageRoute />);
    await screen.findByRole("heading", { name: "Research Bot" });

    fireEvent.click(screen.getByRole("button", { name: "Delete bot" }));
    expect(mocks.botDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete Research Bot" }));

    expect(await screen.findByText("Research Bot was deleted.")).toBeInTheDocument();
    expect(mocks.botDelete.mock.calls[0]?.[0]).toBeUndefined();
    expect(mocks.botDelete.mock.calls[0]?.[1]).toEqual({
      headers: { authorization: expect.stringMatching(/^Bearer /) },
    });
    expect(screen.getByText("No bots yet")).toBeInTheDocument();
  });
});
