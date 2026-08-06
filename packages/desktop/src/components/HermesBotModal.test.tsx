import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AuthUser,
  WorkspaceListItem,
  WorkspaceWithDetails,
} from "@thechat/shared";
import { BOT_CREATED_EVENT } from "../lib/bot-events";
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

const workspaces: WorkspaceListItem[] = [
  {
    id: activeWorkspace.id,
    name: activeWorkspace.name,
    role: "owner",
    createdAt: activeWorkspace.createdAt,
    updatedAt: activeWorkspace.updatedAt,
  },
  {
    id: "workspace-2",
    name: "Second Workspace",
    role: "admin",
    createdAt: "2026-01-02",
    updatedAt: "2026-01-02",
  },
  {
    id: "workspace-3",
    name: "Member Workspace",
    role: "member",
    createdAt: "2026-01-03",
    updatedAt: "2026-01-03",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  createPostMock.mockResolvedValue({
    data: { id: "bot-1", apiKey: "bot_test_token" },
    error: null,
  });
  selectWorkspaceMock.mockResolvedValue(undefined);
  useAuthStore.setState({ user, token: "human-token", loading: false });
  useWorkspacesStore.setState({
    workspaces,
    activeWorkspace,
    loading: false,
    selectWorkspace: selectWorkspaceMock,
  });
  openHermesBotModal();
});

describe("HermesBotModal", () => {
  it("asks for an eligible workspace and bot name only", () => {
    render(<HermesBotModal />);

    expect(screen.getByRole("heading", { name: "Add Hermes Bot" })).toBeInTheDocument();
    expect(screen.getByLabelText("Workspace")).toHaveValue(activeWorkspace.id);
    expect(screen.getByRole("option", { name: "Second Workspace" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Member Workspace" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Bot name")).toBeInTheDocument();
    expect(screen.queryByText("Default instructions")).not.toBeInTheDocument();
    expect(screen.queryByText("Allow message attachments")).not.toBeInTheDocument();
  });

  it("uses modal dialog semantics and restores focus to its launcher on Escape", async () => {
    const launcher = document.createElement("button");
    launcher.textContent = "Add Hermes bot";
    document.body.appendChild(launcher);
    launcher.focus();
    openHermesBotModal();

    render(<HermesBotModal />);
    const dialog = screen.getByRole("dialog", { name: "Add Hermes Bot" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByPlaceholderText("Koda")).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(launcher).toHaveFocus();
    launcher.remove();
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

  it("creates in a selected workspace without requiring an active workspace", async () => {
    useWorkspacesStore.setState({ activeWorkspace: null });
    const botCreated = vi.fn();
    window.addEventListener(BOT_CREATED_EVENT, botCreated);
    render(<HermesBotModal />);

    fireEvent.change(screen.getByLabelText("Workspace"), {
      target: { value: "workspace-2" },
    });
    fireEvent.change(screen.getByLabelText("Bot name"), {
      target: { value: "Workspace Bot" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Bot" }));

    await waitFor(() => expect(createPostMock).toHaveBeenCalledTimes(1));
    expect(createPostMock).toHaveBeenCalledWith(
      {
        kind: "hermes",
        workspaceId: "workspace-2",
        name: "Workspace Bot",
      },
      { headers: { authorization: "Bearer human-token" } },
    );
    expect(selectWorkspaceMock).not.toHaveBeenCalled();
    expect(botCreated).toHaveBeenCalledOnce();
    expect(
      await screen.findByDisplayValue(/THECHAT_BOT_TOKEN=bot_test_token/),
    ).toBeInTheDocument();

    window.removeEventListener(BOT_CREATED_EVENT, botCreated);
  });
});
