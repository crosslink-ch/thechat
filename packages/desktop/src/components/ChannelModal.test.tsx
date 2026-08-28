import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser, WorkspaceChannel, WorkspaceWithDetails } from "@thechat/shared";
import { useConversationsStore } from "../stores/conversations";
import { useWorkspacesStore } from "../stores/workspaces";
import { useAuthStore } from "../stores/auth";
import {
  ChannelModal,
  closeChannelModal,
  openCreateChannelModal,
  openDeleteChannelModal,
  openRenameChannelModal,
} from "./ChannelModal";

const general: WorkspaceChannel = {
  id: "ch-general",
  workspaceId: "ws-1",
  name: "general",
  title: "General",
  isPrivate: false,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};

const product: WorkspaceChannel = {
  id: "ch-product",
  workspaceId: "ws-1",
  name: "product",
  title: "Product",
  isPrivate: false,
  createdAt: "2026-01-02",
  updatedAt: "2026-01-02",
};

const user: AuthUser = {
  id: "u1",
  name: "Test User",
  email: "test@example.com",
  avatar: null,
  type: "human",
};

const collaborator: AuthUser = {
  id: "u2",
  name: "Avery Stone",
  email: "avery@example.com",
  avatar: null,
  type: "human",
};

const workspace: WorkspaceWithDetails = {
  id: "ws-1",
  name: "Team Alpha",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  members: [
    {
      userId: user.id,
      role: "owner",
      joinedAt: "2026-01-01",
      user,
    },
    {
      userId: collaborator.id,
      role: "member",
      joinedAt: "2026-01-02",
      user: collaborator,
    },
  ],
  channels: [general, product],
};

function ModalHarness() {
  return (
    <>
      <button type="button">Dialog launcher</button>
      <ChannelModal />
    </>
  );
}

async function renderModal(initialEntry = "/") {
  const rootRoute = createRootRoute({ component: ModalHarness });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const channelRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/channel/$id",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, channelRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });

  await act(async () => {
    render(<RouterProvider router={router as any} />);
  });
  return router;
}

beforeEach(() => {
  closeChannelModal();
  useAuthStore.setState({ user, token: "token", loading: false });
  useWorkspacesStore.setState({
    workspaces: [],
    activeWorkspace: workspace,
    loading: false,
  });
  useConversationsStore.setState({ unreadChannels: new Set() });
});

describe("ChannelModal", () => {
  it("creates a private channel with explicitly selected workspace members", async () => {
    const created: WorkspaceChannel = {
      ...product,
      id: "ch-leadership",
      name: "leadership",
      title: "Leadership",
      isPrivate: true,
    };
    const createChannel = vi.fn().mockResolvedValue(created);
    useWorkspacesStore.setState({ createChannel });
    await renderModal();

    act(() => openCreateChannelModal());
    expect(screen.getByRole("radio", { name: /Public/ })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: /Private/ }));
    expect(screen.getByRole("radio", { name: /Private/ })).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Test User (you)" }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Test User (you)" }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Include Avery Stone" }),
    );
    fireEvent.change(screen.getByLabelText("Channel name"), {
      target: { value: "Leadership" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create channel" }));

    await waitFor(() =>
      expect(createChannel).toHaveBeenCalledWith("Leadership", {
        isPrivate: true,
        memberIds: [collaborator.id],
      }),
    );
  });

  it("traps focus, closes on Escape, and restores the launcher", async () => {
    const ui = userEvent.setup();
    await renderModal();
    const launcher = screen.getByRole("button", { name: "Dialog launcher" });
    launcher.focus();

    act(() => openDeleteChannelModal(general));
    const dialog = screen.getByRole("dialog", { name: "Delete #general?" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus(),
    );

    for (let index = 0; index < 4; index += 1) {
      await ui.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }

    await ui.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(launcher).toHaveFocus();
  });

  it("creates a slugged channel and navigates to it", async () => {
    const created: WorkspaceChannel = {
      ...product,
      id: "ch-launch-plan",
      name: "launch-plan",
      title: "Launch Plan",
    };
    const createChannel = vi.fn().mockResolvedValue(created);
    useWorkspacesStore.setState({ createChannel });
    const router = await renderModal();

    act(() => openCreateChannelModal());
    const dialog = screen.getByRole("dialog", { name: "Create a channel" });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveClass("bg-surface");
    expect(dialog).not.toHaveClass("bg-sidebar");
    await waitFor(() =>
      expect(screen.getByLabelText("Channel name")).toHaveFocus(),
    );

    fireEvent.change(screen.getByLabelText("Channel name"), {
      target: { value: "Launch   Plan" },
    });
    expect(screen.getByText("#launch-plan")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create channel" }));

    await waitFor(() => expect(createChannel).toHaveBeenCalledWith("Launch   Plan"));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/channel/ch-launch-plan"),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renames a channel and keeps API errors in the dialog", async () => {
    const renameChannel = vi
      .fn()
      .mockRejectedValueOnce(new Error("A channel with this name already exists"))
      .mockResolvedValueOnce({ ...product, name: "design", title: "Design" });
    useWorkspacesStore.setState({ renameChannel });
    await renderModal();

    act(() => openRenameChannelModal(product));
    const input = screen.getByLabelText("Channel name");
    expect(input).toHaveValue("Product");
    fireEvent.change(input, { target: { value: "General" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A channel with this name already exists",
    );
    expect(screen.getByRole("dialog", { name: "Rename channel" })).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "Design" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(renameChannel).toHaveBeenLastCalledWith(product.id, "Design"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps channel creation available to regular workspace members", async () => {
    const createChannel = vi.fn().mockResolvedValue(general);
    useWorkspacesStore.setState({
      createChannel,
      activeWorkspace: {
        ...workspace,
        members: workspace.members.map((member) => ({
          ...member,
          role: "member" as const,
        })),
      },
    });
    await renderModal();

    await act(async () => openCreateChannelModal());
    fireEvent.change(screen.getByRole("textbox", { name: "Channel name" }), {
      target: { value: "Member Channel" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create channel" }));

    await waitFor(() => {
      expect(createChannel).toHaveBeenCalledWith("Member Channel");
    });
  });

  it("closes an open channel mutation when the current user loses manager access", async () => {
    const renameChannel = vi.fn();
    useWorkspacesStore.setState({ renameChannel });
    await renderModal();

    act(() => openRenameChannelModal(product));
    expect(screen.getByRole("dialog", { name: "Rename channel" })).toBeInTheDocument();

    act(() => {
      useWorkspacesStore.setState({
        activeWorkspace: {
          ...workspace,
          members: workspace.members.map((member) => ({
            ...member,
            role: "member" as const,
          })),
        },
      });
    });

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(renameChannel).not.toHaveBeenCalled();
  });

  it("confirms deletion and moves away from the deleted active channel", async () => {
    const deleteChannel = vi.fn().mockImplementation(async (channelId: string) => {
      useWorkspacesStore.setState((state) => ({
        activeWorkspace: state.activeWorkspace
          ? {
              ...state.activeWorkspace,
              channels: state.activeWorkspace.channels.filter(
                (channel) => channel.id !== channelId,
              ),
            }
          : null,
      }));
    });
    const markChannelRead = vi.fn();
    useWorkspacesStore.setState({ deleteChannel });
    useConversationsStore.setState({ markChannelRead });
    const router = await renderModal("/channel/ch-general");

    act(() => openDeleteChannelModal(general));
    expect(
      screen.getByRole("dialog", { name: "Delete #general?" }),
    ).toHaveTextContent("This cannot be undone");
    fireEvent.click(screen.getByRole("button", { name: "Delete channel" }));

    await waitFor(() => expect(deleteChannel).toHaveBeenCalledWith(general.id));
    expect(markChannelRead).toHaveBeenCalledWith(general.id);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/channel/ch-product"),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
