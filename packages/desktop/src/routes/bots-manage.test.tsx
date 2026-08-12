import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  rpcConfigGet: vi.fn(),
  rpcConfigPatch: vi.fn(),
  rpcTestPost: vi.fn(),
  openHermesBotModal: vi.fn(),
}));

vi.mock("../lib/api", () => {
  const bots = Object.assign(
    ({ botId }: { botId: string }) => ({
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
      "hermes-rpc": {
        get: (options: unknown) => mocks.rpcConfigGet(botId, options),
        patch: mocks.rpcConfigPatch,
        test: { post: mocks.rpcTestPost },
      },
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

const secondOwnedBot: OwnedBot = {
  ...ownedBot,
  id: "bot-2",
  userId: "bot-user-2",
  name: "Operations Bot",
  webhookSecret: "whsec_second",
};

const rpcOwnedBot: OwnedBot = {
  ...ownedBot,
  id: "bot-rpc",
  userId: "bot-user-rpc",
  name: "Upstream Hermes",
  kind: "hermes-rpc",
};

const secondRpcOwnedBot: OwnedBot = {
  ...rpcOwnedBot,
  id: "bot-rpc-2",
  userId: "bot-user-rpc-2",
  name: "Second Upstream Hermes",
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
    mocks.rpcConfigGet.mockResolvedValue({
      data: {
        botId: rpcOwnedBot.id,
        endpoint: "ws://127.0.0.1:8642/api/ws",
        gatewayTokenConfigured: true,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
      error: null,
    });
    mocks.rpcConfigPatch.mockResolvedValue({
      data: {
        botId: rpcOwnedBot.id,
        endpoint: "wss://hermes.example/api/ws",
        gatewayTokenConfigured: true,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z",
      },
      error: null,
    });
    mocks.rpcTestPost.mockResolvedValue({
      data: { latencyMs: 24, sessionCountSampled: 1, gatewayReady: true },
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

  it("manages Hermes RPC connection without webhook or bot API-key controls", async () => {
    mocks.listGet.mockResolvedValue({ data: [rpcOwnedBot], error: null });
    mocks.botGet.mockResolvedValue({ data: rpcOwnedBot, error: null });
    render(<BotsManageRoute />);

    expect(await screen.findByTestId("hermes-rpc-connection")).toBeInTheDocument();
    expect(screen.getAllByText("Hermes RPC", { selector: "span" }).length).toBeGreaterThan(0);
    expect(screen.getByTitle("Hermes RPC connection")).toBeInTheDocument();
    expect(screen.queryByTitle(/API key/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Webhook URL")).not.toBeInTheDocument();
    expect(screen.queryByText("Bot API key")).not.toBeInTheDocument();
    expect(screen.queryByText("Webhook secret")).not.toBeInTheDocument();
    expect(await screen.findByTestId("hermes-rpc-token-status")).toHaveTextContent(
      "A gateway token is configured",
    );
    expect(screen.queryByDisplayValue(/token/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Hermes RPC endpoint"), {
      target: { value: "https://hermes.example" },
    });
    fireEvent.change(screen.getByLabelText("Replace Hermes RPC gateway token"), {
      target: { value: "replacement-write-only" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
    await waitFor(() => expect(mocks.rpcConfigPatch).toHaveBeenCalledWith(
      {
        endpoint: "https://hermes.example",
        gatewayToken: "replacement-write-only",
      },
      expect.objectContaining({ headers: { authorization: "Bearer user-token" } }),
    ));

    fireEvent.click(screen.getByRole("button", { name: "Test Hermes RPC connection" }));
    expect(await screen.findByText(/Connected in 24 ms/)).toBeInTheDocument();
    expect(mocks.rpcTestPost).toHaveBeenCalledOnce();
  });

  it("remounts the RPC editor so a delayed prior-bot load cannot overwrite it", async () => {
    mocks.listGet.mockResolvedValue({
      data: [rpcOwnedBot, secondRpcOwnedBot],
      error: null,
    });
    let resolveFirst!: (value: unknown) => void;
    const firstLoad = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    mocks.rpcConfigGet.mockImplementation((botId: string) => {
      if (botId === rpcOwnedBot.id) return firstLoad;
      return Promise.resolve({
        data: {
          botId: secondRpcOwnedBot.id,
          endpoint: "ws://second.example/api/ws",
          gatewayTokenConfigured: false,
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
        error: null,
      });
    });

    render(<BotsManageRoute />);
    await waitFor(() => expect(mocks.rpcConfigGet).toHaveBeenCalledWith(
      rpcOwnedBot.id,
      expect.anything(),
    ));
    fireEvent.click(await screen.findByTestId(`bot-list-item-${secondRpcOwnedBot.id}`));
    expect(await screen.findByDisplayValue("ws://second.example/api/ws")).toBeInTheDocument();

    await act(async () => {
      resolveFirst({
        data: {
          botId: rpcOwnedBot.id,
          endpoint: "ws://first-delayed.example/api/ws",
          gatewayTokenConfigured: true,
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
        error: null,
      });
      await firstLoad;
    });

    expect(screen.getByLabelText("Hermes RPC endpoint")).toHaveValue(
      "ws://second.example/api/ws",
    );
    expect(screen.queryByDisplayValue("ws://first-delayed.example/api/ws")).not.toBeInTheDocument();
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

  it("never displays a delayed API-key response under a different bot", async () => {
    let resolveRotation!: (value: {
      data: { apiKey: string };
      error: null;
    }) => void;
    mocks.listGet.mockResolvedValue({ data: [ownedBot, secondOwnedBot], error: null });
    mocks.rotateKeyPost.mockReturnValue(
      new Promise((resolve) => {
        resolveRotation = resolve;
      }),
    );

    render(<BotsManageRoute />);
    await screen.findByRole("heading", { name: "Research Bot" });

    fireEvent.click(screen.getAllByRole("button", { name: "Rotate" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Confirm new key" }));
    fireEvent.click(screen.getByTestId("bot-list-item-bot-2"));
    expect(await screen.findByRole("heading", { name: "Operations Bot" })).toBeInTheDocument();

    await act(async () => {
      resolveRotation({ data: { apiKey: "tc_key_for_research_bot" }, error: null });
    });
    await waitFor(() => expect(mocks.rotateKeyPost).toHaveBeenCalledOnce());
    expect(screen.queryByDisplayValue("tc_key_for_research_bot")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("bot-list-item-bot-1"));
    expect(await screen.findByDisplayValue("tc_key_for_research_bot")).toBeInTheDocument();
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
