import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser, WorkspaceChannel, WorkspaceMember, WorkspaceWithDetails } from "@thechat/shared";
import { useAuthStore } from "../stores/auth";
import { useConversationsStore } from "../stores/conversations";
import { useWorkspacesStore } from "../stores/workspaces";
import {
  ChannelDetailsModal,
  closeChannelDetailsModal,
  openChannelDetailsModal,
} from "./ChannelDetailsModal";

const { openRenameChannelModalMock, openDeleteChannelModalMock } = vi.hoisted(() => ({
  openRenameChannelModalMock: vi.fn(),
  openDeleteChannelModalMock: vi.fn(),
}));
vi.mock("./ChannelModal", () => ({
  openRenameChannelModal: openRenameChannelModalMock,
  openDeleteChannelModal: openDeleteChannelModalMock,
}));

const person = (id: string, name: string): AuthUser => ({ id, name, email: `${id}@example.com`, avatar: null, type: "human" });
const me = person("u-me", "Morgan Owner");
const avery = person("u-avery", "Avery Picked");
const nora = person("u-nora", "Nora Outside");
const member = (user: AuthUser, role: WorkspaceMember["role"] = "member"): WorkspaceMember => ({
  userId: user.id, role, joinedAt: "2026-01-01", user,
});

const general: WorkspaceChannel = {
  id: "ch-general", workspaceId: "ws-1", name: "general", title: "General", isPrivate: false,
  createdAt: "2026-01-01", updatedAt: "2026-01-01",
};
const leadership: WorkspaceChannel = {
  id: "ch-leadership", workspaceId: "ws-1", name: "leadership", title: "Leadership", isPrivate: true,
  members: [{ userId: me.id, role: "admin" }, { userId: avery.id, role: "member" }],
  createdAt: "2026-01-02", updatedAt: "2026-01-02",
};

function workspace(
  myWorkspaceRole: WorkspaceMember["role"],
  channels: WorkspaceChannel[] = [general, leadership],
): WorkspaceWithDetails {
  return {
    id: "ws-1", name: "Acme", createdAt: "2026-01-01", updatedAt: "2026-01-01",
    members: [member(me, myWorkspaceRole), member(avery), member(nora)],
    channels,
  };
}

async function renderModal(initialEntry = "/") {
  const rootRoute = createRootRoute({ component: () => <ChannelDetailsModal /> });
  const routes = ["/", "/channel/$id"].map((path) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  await act(async () => {
    render(<RouterProvider router={router as any} />);
  });
  return router;
}

const open = (channelId: string, options?: Parameters<typeof openChannelDetailsModal>[1]) =>
  act(() => openChannelDetailsModal(channelId, options));

beforeEach(() => {
  vi.clearAllMocks();
  closeChannelDetailsModal();
  useAuthStore.setState({ user: me, token: "token", loading: false });
  useWorkspacesStore.setState({ workspaces: [], activeWorkspace: workspace("member"), loading: false });
  useConversationsStore.setState({ unreadChannels: new Set() });
});

describe("ChannelDetailsModal", () => {
  it("lists the members of a private channel and lets its admin manage them", async () => {
    const ui = userEvent.setup();
    const removeChannelMember = vi.fn().mockResolvedValue(false);
    const setChannelMemberRole = vi.fn().mockResolvedValue(leadership);
    useWorkspacesStore.setState({ removeChannelMember, setChannelMemberRole });
    await renderModal();
    await open(leadership.id);

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "leadership" })).toBeInTheDocument();
    const list = within(dialog).getByRole("region", { name: "Members" });
    expect(within(list).getByText("Morgan Owner (you)")).toBeInTheDocument();
    expect(within(list).getByText("Channel admin")).toBeInTheDocument();
    expect(within(list).getByText("Avery Picked")).toBeInTheDocument();
    expect(within(list).queryByText("Nora Outside")).not.toBeInTheDocument();
    // Nobody removes or demotes themselves from the member row.
    expect(within(dialog).queryByRole("button", { name: "Remove Morgan Owner from channel" })).not.toBeInTheDocument();

    await ui.click(within(dialog).getByRole("button", { name: "Make Avery Picked a channel admin" }));
    expect(setChannelMemberRole).toHaveBeenCalledWith(leadership.id, avery.id, "admin");
    await ui.click(within(dialog).getByRole("button", { name: "Remove Avery Picked from channel" }));
    expect(removeChannelMember).toHaveBeenCalledWith(leadership.id, avery.id);
  });

  it("lets any member add people, offering only workspace members who are not in the channel", async () => {
    const ui = userEvent.setup();
    const addChannelMembers = vi.fn().mockResolvedValue(leadership);
    useWorkspacesStore.setState({
      addChannelMembers,
      activeWorkspace: workspace("member", [
        general,
        { ...leadership, members: [{ userId: avery.id, role: "admin" }, { userId: me.id, role: "member" }] },
      ]),
    });
    await renderModal();
    await open(leadership.id);
    const dialog = screen.getByRole("dialog");

    // An ordinary member: no management controls, but can add and leave.
    expect(within(dialog).queryByRole("button", { name: "Rename" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Make public" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Delete channel" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Remove Avery Picked/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Leave channel" })).toBeInTheDocument();

    await ui.click(within(dialog).getByRole("button", { name: "Add people" }));
    expect(within(dialog).queryByRole("checkbox", { name: "Add Avery Picked" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Add" })).toBeDisabled();
    await ui.click(within(dialog).getByRole("checkbox", { name: "Add Nora Outside" }));
    await ui.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(addChannelMembers).toHaveBeenCalledWith(leadership.id, [nora.id]);
    await waitFor(() => expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument());
  });

  it("asks before making a private channel public", async () => {
    const ui = userEvent.setup();
    const setChannelVisibility = vi.fn().mockResolvedValue({ ...leadership, isPrivate: false });
    useWorkspacesStore.setState({ setChannelVisibility });
    await renderModal();
    await open(leadership.id);
    const dialog = screen.getByRole("dialog");

    await ui.click(within(dialog).getByRole("button", { name: "Make public" }));
    expect(setChannelVisibility).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/Everyone in the workspace will be added and can read all messages/)).toBeInTheDocument();
    await ui.click(within(dialog).getByRole("button", { name: "Make public" }));
    expect(setChannelVisibility).toHaveBeenCalledWith(leadership.id, false);
  });

  it("shows a public channel as the whole workspace, managed by workspace managers only", async () => {
    const ui = userEvent.setup();
    await renderModal();
    await open(general.id);
    let dialog = screen.getByRole("dialog");
    // A regular workspace member sees who is in it and nothing to change.
    expect(within(dialog).getByText("Nora Outside")).toBeInTheDocument();
    expect(within(dialog).queryByRole("region", { name: "Channel settings" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Add people" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /from channel/ })).not.toBeInTheDocument();

    const product: WorkspaceChannel = { ...general, id: "ch-product", name: "product", title: "Product" };
    act(() => {
      closeChannelDetailsModal();
      useWorkspacesStore.setState({ activeWorkspace: workspace("owner", [general, product]) });
    });
    await open(general.id);
    dialog = screen.getByRole("dialog");
    // The general channel can be renamed but never made private.
    expect(within(dialog).getByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Make private" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Leave channel" })).not.toBeInTheDocument();

    act(() => closeChannelDetailsModal());
    await open(product.id);
    dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Make private" })).toBeInTheDocument();
    await ui.click(within(dialog).getByRole("button", { name: "Delete channel" }));
    expect(openDeleteChannelModalMock).toHaveBeenCalledWith(product);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("leaves the open channel and moves to one that is still visible", async () => {
    const ui = userEvent.setup();
    const removeChannelMember = vi.fn().mockImplementation(async () => {
      useWorkspacesStore.setState({ activeWorkspace: workspace("member", [general]) });
      return false;
    });
    useWorkspacesStore.setState({ removeChannelMember });
    const router = await renderModal(`/channel/${leadership.id}`);
    await open(leadership.id, { confirm: "leave" });
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).getByText(/Someone in it can add you back/)).toBeInTheDocument();
    await ui.click(within(dialog).getByRole("button", { name: "Leave channel" }));
    expect(removeChannelMember).toHaveBeenCalledWith(leadership.id, me.id);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/channel/${general.id}`));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("warns the last person that leaving deletes the channel", async () => {
    useWorkspacesStore.setState({
      activeWorkspace: workspace("member", [general, { ...leadership, members: [{ userId: me.id, role: "admin" }] }]),
    });
    await renderModal();
    await open(leadership.id, { confirm: "leave" });
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/You are the last person in this channel/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Leave and delete" })).toBeInTheDocument();
  });

  it("closes when this person is removed from the channel while it is open, and reports a refused change", async () => {
    const ui = userEvent.setup();
    const removeChannelMember = vi.fn().mockRejectedValue(new Error("Only channel admins can manage this channel"));
    useWorkspacesStore.setState({ removeChannelMember });
    await renderModal();
    await open(leadership.id);
    const dialog = screen.getByRole("dialog");
    await ui.click(within(dialog).getByRole("button", { name: "Remove Avery Picked from channel" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Only channel admins can manage this channel");

    act(() => useWorkspacesStore.setState({ activeWorkspace: workspace("member", [general]) }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
