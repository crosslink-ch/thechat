import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../platform/environment", () => ({ isWeb: true }));
vi.mock("../lib/api", () => ({ api: { auth: {
  login: { post: vi.fn() }, register: { post: vi.fn() }, "verify-email": { post: vi.fn() },
  me: { get: vi.fn(), patch: vi.fn() }, logout: { post: vi.fn() },
} } }));
import { api } from "../lib/api";
import { useAuthStore } from "./auth";
import { queryClient } from "../lib/query-client";
import { resetPrivateSession } from "../lib/session-boundary";
it("does not apply an earlier cookie account's delayed profile save", async () => {
  useAuthStore.setState({ user, token: null, loading: false });
  let finish!: (value: unknown) => void;
  vi.mocked(api.auth.me.patch).mockImplementation(() => new Promise(resolve => { finish = resolve as never; }) as never);
  const operation = useAuthStore.getState().updateName("Old name");
  await vi.waitFor(() => expect(finish).toBeDefined());
  resetPrivateSession();
  const next = { ...user, id: "bob" }; useAuthStore.setState({ user: next });
  finish({ data: { user: { ...user, name: "Old name" } }, error: null });
  await expect(operation).rejects.toThrow("Authentication state changed");
  expect(useAuthStore.getState().user).toEqual(next);
});
import { useWorkspacesStore } from "./workspaces";
import { useComposerDraftsStore } from "./composer-drafts";
import { useConversationsStore } from "./conversations";

it("clears private account caches on logout before another account can render", async () => {
  useAuthStore.setState({ user, token: null, loading: false });
  queryClient.setQueryData(["private"], "alice-secret");
  useComposerDraftsStore.getState().setDraft("account:alice:dm:c", "private draft");
  useConversationsStore.getState().rememberDirectConversation("bob", "private-dm");
  useWorkspacesStore.setState({ workspaces: [{ id: "private-ws" }] as never });
  vi.mocked(api.auth.logout.post).mockResolvedValue({ data: {}, error: null } as never);
  await useAuthStore.getState().logout();
  expect(queryClient.getQueryData(["private"])).toBeUndefined();
  expect(useComposerDraftsStore.getState().drafts).toEqual({});
  expect(useConversationsStore.getState().directConversationIdsByUserId).toEqual({});
  expect(useWorkspacesStore.getState().workspaces).toEqual([]);
});

it("supports authenticated profile mutations without requiring a bearer", async () => {
  useAuthStore.setState({ user, token: null, loading: false });
  vi.mocked(api.auth.me.patch).mockResolvedValue({ data: { user: { ...user, name: "Updated" } }, error: null } as never);
  await useAuthStore.getState().updateName("Updated");
  expect(useAuthStore.getState().user?.name).toBe("Updated");
  expect(invoke).not.toHaveBeenCalled();
});
const user = { id: "alice", name: "Alice", email: "alice@example.invalid", type: "human", avatar: null } as const;
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear(); sessionStorage.clear();
  useAuthStore.setState({ user: null, token: null, loading: true });
});
it.each(["login", "register", "verify-email"] as const)("accepts %s cookie identity without persisting any credentials or user", async (method) => {
  vi.mocked(api.auth[method].post).mockResolvedValue({ data: { user }, error: null } as never);
  if (method === "login") await useAuthStore.getState().login(user.email, "secret");
  if (method === "register") await useAuthStore.getState().register(user.name, user.email, "secret");
  if (method === "verify-email") await useAuthStore.getState().verifyEmailOtp(user.email, "123456");
  expect(useAuthStore.getState()).toMatchObject({ user, token: null });
  expect(invoke).not.toHaveBeenCalled();
  expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(user.email);
});
it("restores exclusively from the server with no JS token or offline identity", async () => {
  vi.mocked(api.auth.me.get).mockResolvedValue({ data: { user }, error: null } as never);
  await useAuthStore.getState().initialize();
  expect(api.auth.me.get).toHaveBeenCalled();
  expect(useAuthStore.getState()).toMatchObject({ user, token: null, loading: false });
  expect(invoke).not.toHaveBeenCalled();
});
it("revokes cookie session even though token is null", async () => {
  useAuthStore.setState({ user, token: null, loading: false });
  vi.mocked(api.auth.logout.post).mockResolvedValue({ data: {}, error: null } as never);
  await useAuthStore.getState().logout();
  expect(api.auth.logout.post).toHaveBeenCalledWith({}, { headers: { "X-TheChat-Client": "web" } });
  expect(useAuthStore.getState()).toMatchObject({ user: null, token: null });
  expect(invoke).not.toHaveBeenCalled();
});
