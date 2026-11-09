import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceChannel, WorkspaceWithDetails } from "@thechat/shared";
import { useAuthStore } from "../stores/auth";
import { useWorkspacesStore } from "../stores/workspaces";
import { resetPrivateSession } from "../lib/session-boundary";
import {
  IncomingWebhooksModal,
  openIncomingWebhooksModal,
  closeIncomingWebhooksModal,
} from "./IncomingWebhooksModal";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("../lib/api", () => ({
  API_URL: "http://localhost:3000",
  api: {
    channels: () => ({
      "incoming-webhooks": Object.assign(() => ({ delete: mocks.remove }), {
        get: mocks.get,
        post: mocks.post,
      }),
    }),
  },
}));
const channel: WorkspaceChannel = {
  id: "channel",
  name: "ops",
  title: "Ops",
  workspaceId: "workspace",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};
const user = {
  id: "owner",
  name: "Owner",
  type: "human" as const,
  email: "owner@example.invalid",
  avatar: null,
};
const workspace: WorkspaceWithDetails = {
  id: "workspace",
  name: "Team",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  channels: [channel],
  members: [{ userId: user.id, user, role: "owner", joinedAt: "2026-01-01" }],
};
const webhook = {
  id: "hook",
  name: "Uptime Kuma",
  tokenStart: "tchat_wh_12345678",
  createdAt: "2026-01-01T12:00:00Z",
  lastUsedAt: null,
};
beforeEach(() => {
  closeIncomingWebhooksModal();
  vi.clearAllMocks();
  useAuthStore.setState({ user, token: "session" });
  useWorkspacesStore.setState({ activeWorkspace: workspace });
  mocks.get.mockResolvedValue({ data: { webhooks: [] }, error: null });
  mocks.post.mockResolvedValue({
    data: { webhook, path: "/hooks/incoming/tchat_wh_synthetic" },
    error: null,
  });
  mocks.remove.mockResolvedValue({ data: { ok: true }, error: null });
});
function open() {
  act(() => openIncomingWebhooksModal(channel));
}
it("creates, reveals once, reloads safe metadata and requires revoke confirmation", async () => {
  render(<IncomingWebhooksModal />);
  open();
  await screen.findByText("No incoming webhooks yet.");
  fireEvent.change(screen.getByLabelText("Webhook name"), {
    target: { value: "Uptime Kuma" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create webhook" }));
  const secret = await screen.findByLabelText("New webhook URL");
  expect(secret).toHaveValue(
    "http://localhost:3000/hooks/incoming/tchat_wh_synthetic",
  );
  expect(mocks.post).toHaveBeenCalledWith(
    { name: "Uptime Kuma" },
    expect.anything(),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Close incoming webhooks" }),
  );
  mocks.get.mockResolvedValue({ data: { webhooks: [webhook] }, error: null });
  open();
  await screen.findByText("Uptime Kuma");
  expect(screen.queryByLabelText("New webhook URL")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Revoke Uptime Kuma" }));
  expect(mocks.remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));
  await waitFor(() => expect(mocks.remove).toHaveBeenCalledTimes(1));
  await screen.findByText("No incoming webhooks yet.");
});
it("shows API errors and allows a failed list to be retried", async () => {
  mocks.get.mockResolvedValueOnce({
    data: null,
    error: { value: { error: "Try again" } },
  });
  render(<IncomingWebhooksModal />);
  open();
  expect(await screen.findByRole("alert")).toHaveTextContent("Try again");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("No incoming webhooks yet.");
});
it("never reveals a delayed creation after logout or workspace change", async () => {
  let resolve!: (value: unknown) => void;
  mocks.post.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  render(<IncomingWebhooksModal />);
  open();
  await screen.findByText("No incoming webhooks yet.");
  fireEvent.change(screen.getByLabelText("Webhook name"), {
    target: { value: "Late" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create webhook" }));
  act(() => resetPrivateSession());
  await act(async () =>
    resolve({
      data: { webhook, path: "/hooks/incoming/late-secret" },
      error: null,
    }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByDisplayValue(/late-secret/)).toBeNull();
  act(() => {
    useAuthStore.setState({ user, token: "new-session" });
    useWorkspacesStore.setState({ activeWorkspace: workspace });
  });
  open();
  await screen.findByRole("dialog");
  act(() =>
    useWorkspacesStore.setState({
      activeWorkspace: { ...workspace, id: "other" },
    }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("does not open for ordinary members", () => {
  useWorkspacesStore.setState({
    activeWorkspace: {
      ...workspace,
      members: [{ ...workspace.members[0], role: "member" }],
    },
  });
  render(<IncomingWebhooksModal />);
  open();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(mocks.get).not.toHaveBeenCalled();
});
