import { beforeEach, expect, it, vi } from "vitest";
import type { AuthUser, WorkspaceWithDetails } from "@thechat/shared";

const { listGet, workspaceRoute, preferenceGet } = vi.hoisted(() => ({
  listGet: vi.fn(), workspaceRoute: vi.fn(), preferenceGet: vi.fn(),
}));
vi.mock("../lib/api", () => ({ api: {
  workspaces: Object.assign(workspaceRoute, { list: { get: listGet } }),
} }));
vi.mock("../platform/preferences", () => ({ preferences: { get: preferenceGet, set: vi.fn().mockResolvedValue(undefined) } }));
import { useAuthStore } from "./auth";
import { useWorkspacesStore } from "./workspaces";

const user: AuthUser = { id: "u1", name: "Owner", email: "o@example.invalid", avatar: null, type: "human" };
const ws = (id: string): WorkspaceWithDetails => ({ id, name: id, createdAt: "x", updatedAt: "x", members: [], channels: [] });
const list = ["ws-1", "ws-2", "ws-3"].map((id) => ({ ...ws(id), role: "owner" as const }));

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user, token: "token", loading: false });
  useWorkspacesStore.getState().reset();
  preferenceGet.mockResolvedValue("ws-1");
  listGet.mockResolvedValue({ data: list, error: null });
});

it("cold start from a notification link (/open?workspaceId=) still loads the workspace list", async () => {
  let resolveSelection!: (value: unknown) => void;
  workspaceRoute.mockImplementation(({ id }: { id: string }) => ({
    get: id === "ws-2"
      ? vi.fn().mockImplementation(() => new Promise((resolve) => { resolveSelection = resolve; }))
      : vi.fn().mockResolvedValue({ data: ws(id), error: null }),
  }));

  // OpenConversationRoute's effect runs before RootLayout's effect.
  const selecting = useWorkspacesStore.getState().selectWorkspace("ws-2");
  const initializing = useWorkspacesStore.getState().initialize();
  resolveSelection({ data: ws("ws-2"), error: null });
  await selecting;
  await initializing;
  await new Promise((resolve) => setTimeout(resolve, 0));

  const state = useWorkspacesStore.getState();
  expect(state.activeWorkspace?.id).toBe("ws-2");
  expect(state.workspaces.map((w) => w.id)).toEqual(["ws-1", "ws-2", "ws-3"]);
  // The saved workspace (ws-1) is not restored over the notification's.
  expect(workspaceRoute).not.toHaveBeenCalledWith({ id: "ws-1" });
});
