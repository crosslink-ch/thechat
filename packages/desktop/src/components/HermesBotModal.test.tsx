import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AuthUser, WorkspaceWithDetails } from "@thechat/shared";
import { useAuthStore } from "../stores/auth";
import { useWorkspacesStore } from "../stores/workspaces";
import { HermesBotModal, openHermesBotModal } from "./HermesBotModal";

const { createPostMock, selectWorkspaceMock } = vi.hoisted(() => ({
  createPostMock: vi.fn(),
  selectWorkspaceMock: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  API_URL: "https://thechat.test",
  api: {
    bots: {
      create: { post: createPostMock },
    },
  },
}));

vi.mock("../stores/input-focus", () => ({ requestInputBarFocus: vi.fn() }));

const user: AuthUser = {
  id: "user-1",
  name: "Owner",
  email: "owner@example.com",
  avatar: null,
  type: "human",
};

const activeWorkspace: WorkspaceWithDetails = {
  id: "workspace-1",
  name: "Workspace",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  members: [
    {
      userId: user.id,
      role: "owner",
      joinedAt: "2026-01-01",
      user,
    },
  ],
  channels: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  createPostMock.mockResolvedValue({
    data: { id: "bot-1", apiKey: "bot_test_token" },
    error: null,
  });
  selectWorkspaceMock.mockResolvedValue(undefined);
  useAuthStore.setState({ user, token: "human-token", loading: false });
  useWorkspacesStore.setState({
    workspaces: [],
    activeWorkspace,
    loading: false,
    selectWorkspace: selectWorkspaceMock,
  });
  openHermesBotModal();
});

describe("HermesBotModal", () => {
  it("only asks for the bot name", () => {
    render(<HermesBotModal />);

    expect(screen.getByRole("heading", { name: "Add Hermes Bot" })).toBeInTheDocument();
    expect(screen.getByLabelText("Bot name")).toBeInTheDocument();
    expect(screen.queryByText("Default instructions")).not.toBeInTheDocument();
    expect(screen.queryByText("Allow message attachments")).not.toBeInTheDocument();
  });

  it("creates a Hermes bot without overriding attachment access or bot instructions", async () => {
    render(<HermesBotModal />);

    fireEvent.change(screen.getByLabelText("Bot name"), { target: { value: "Koda" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Bot" }));

    await waitFor(() => expect(createPostMock).toHaveBeenCalledTimes(1));
    expect(createPostMock).toHaveBeenCalledWith(
      {
        kind: "hermes",
        workspaceId: activeWorkspace.id,
        name: "Koda",
      },
      { headers: { authorization: "Bearer human-token" } },
    );
    expect(createPostMock.mock.calls[0]?.[0]).not.toHaveProperty("attachmentAccess");
    expect(createPostMock.mock.calls[0]?.[0]).not.toHaveProperty("defaultInstructions");
    await waitFor(() => expect(selectWorkspaceMock).toHaveBeenCalledWith(activeWorkspace.id));
    expect(await screen.findByText("Koda was added.", { exact: false })).toBeInTheDocument();
  });
});
