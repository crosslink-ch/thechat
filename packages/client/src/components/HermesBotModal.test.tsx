import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  BOT_AVATAR_COLORS,
  BOT_AVATAR_SHAPES,
  type AuthUser,
  type WorkspaceListItem,
  type WorkspaceWithDetails,
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
  it.each(Array.from({ length: 18 }, (_, i) => (i + 0.99) / 18))(
    "never automatically picks Minimal when randomness is %s", async (random) => {
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(random);
      try {
        render(<HermesBotModal />);
        fireEvent.change(screen.getByLabelText("Bot name"), { target: { value: "Untouched Bot" } });
        fireEvent.click(screen.getByRole("button", { name: "Add Bot" }));
        await waitFor(() => expect(createPostMock).toHaveBeenCalledTimes(1));
        const shape = createPostMock.mock.calls[0][0].avatarShape;
        expect(shape).not.toBe("minimal");
        expect(shape).toBe(BOT_AVATAR_SHAPES[Math.floor(random * 18)]);
      } finally {
        randomSpy.mockRestore();
      }
    },
  );
  it("explains Minimal as opt-in and submits it only after a manual pick", async () => {
    render(<HermesBotModal />);
    fireEvent.click(screen.getByRole("button", { name: "Change avatar" }));
    const minimal = screen.getByRole("button", { name: "Minimal bot" });
    expect(minimal).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText(/Minimal is a static, faceless glyph/)).toHaveTextContent(
      /standard activity indicators.*only when you select it/,
    );
    fireEvent.click(minimal);
    expect(minimal).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByLabelText("Bot name"), { target: { value: "Minimal Assistant" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Bot" }));
    await waitFor(() => expect(createPostMock).toHaveBeenCalledTimes(1));
    expect(createPostMock.mock.calls[0][0]).toMatchObject({ avatarShape: "minimal" });
  });

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
      expect.objectContaining({
        kind: "hermes",
        workspaceId: activeWorkspace.id,
        name: "Koda",
      }),
      { headers: { authorization: "Bearer human-token" } },
    );
    // Untouched, the new bot keeps the random look it was shown with.
    const body = createPostMock.mock.calls[0]?.[0];
    expect(BOT_AVATAR_SHAPES).toContain(body.avatarShape);
    expect(BOT_AVATAR_COLORS).toContain(body.avatarColor);
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
    fireEvent.click(screen.getByRole("button", { name: "Change avatar" }));
    fireEvent.click(screen.getByRole("button", { name: "Ghost bot" }));
    fireEvent.click(screen.getByRole("button", { name: "Mint" }));
    expect(screen.getByRole("button", { name: "Ghost bot" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Add Bot" }));

    await waitFor(() => expect(createPostMock).toHaveBeenCalledTimes(1));
    expect(createPostMock).toHaveBeenCalledWith(
      {
        kind: "hermes",
        workspaceId: "workspace-2",
        name: "Workspace Bot",
        avatarShape: "ghost",
        avatarColor: "#00B894",
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
