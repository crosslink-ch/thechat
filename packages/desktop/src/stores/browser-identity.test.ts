import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../platform/environment", () => ({ isWeb: true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("Native IPC in browser"); }) }));
vi.mock("../lib/api", () => ({ api: { workspaces: { list: { get: vi.fn() } }, invites: { pending: { get: vi.fn() } }, "bot-workspace-invites": { pending: { get: vi.fn() } } } }));
import { useAuthStore } from "./auth";
import { useFontSizeStore } from "./font-size";
import { useWorkspacesStore } from "./workspaces";
import { useNotificationsStore } from "./notifications";
import { api } from "../lib/api";
import { resetPrivateSession } from "../lib/session-boundary";
it("does not restore an old workspace list after an account boundary", async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(api.workspaces.list.get).mockImplementation(() => new Promise(resolve => { finish = resolve as never; }) as never);
  const pending = useWorkspacesStore.getState().initialize();
  await vi.waitFor(() => expect(finish).toBeDefined());
  resetPrivateSession();
  useAuthStore.setState({ user: { ...user, id: "bob" } });
  useWorkspacesStore.setState({ workspaces: [{ id: "bob-workspace" }] as never });
  finish({ data: [{ id: "alice-workspace" }], error: null });
  await pending;
  expect(useWorkspacesStore.getState().workspaces).toEqual([{ id: "bob-workspace" }]);
});
const user = { id: "alice", name: "Alice", email: "a@example.invalid", avatar: null, type: "human" } as const;
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); useAuthStore.setState({ token: null, user, loading: false }); });
it("persists browser font preferences without invoking native services", async () => {
  useFontSizeStore.getState().reset();
  useFontSizeStore.getState().increase();
  await useFontSizeStore.getState().initialize();
  expect(useFontSizeStore.getState().size).toBe(15);
  expect(document.documentElement.style.fontSize).toBe("15px");
});
it("loads workspaces for a cookie identity with a genuinely null token", async () => {
  vi.mocked(api.workspaces.list.get).mockResolvedValue({ data: [{ id: "ws", name: "Workspace" }], error: null } as never);
  await useWorkspacesStore.getState().initialize();
  expect(api.workspaces.list.get).toHaveBeenCalledWith({ headers: { "X-TheChat-Client": "web" } });
  expect(useWorkspacesStore.getState().workspaces).toHaveLength(1);
});
it("loads notifications for a cookie identity", async () => {
  vi.mocked(api.invites.pending.get).mockResolvedValue({ data: [], error: null } as never);
  vi.mocked(api["bot-workspace-invites"].pending.get).mockResolvedValue({ data: [], error: null } as never);
  await useNotificationsStore.getState().fetchNotifications();
  expect(api.invites.pending.get).toHaveBeenCalledWith({ headers: { "X-TheChat-Client": "web" } });
});
