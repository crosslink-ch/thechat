import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../platform/environment", () => ({ isWeb: true }));
import { api } from "./api";
import { authHeaders } from "./eden";
import { useAuthStore } from "../stores/auth";
import { queryClient } from "./query-client";
import { resetPrivateSession } from "./session-boundary";

const user = { id: "alice", name: "Alice", email: "a@example.invalid", type: "human", avatar: null } as const;
it("expires the current browser identity on protected API 401, but not membership 403", async () => {
  useAuthStore.setState({ user, token: null, loading: false });
  const transport = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{}', { status: 403 }));
  await api.workspaces.list.get(authHeaders(null));
  expect(useAuthStore.getState().user).toEqual(user);
  queryClient.setQueryData(["private"], "secret");
  transport.mockResolvedValue(new Response('{}', { status: 401 }));
  await api.workspaces.list.get(authHeaders(null));
  expect(useAuthStore.getState().user).toBeNull();
  expect(queryClient.getQueryData(["private"])).toBeUndefined();
});
it.each([200, 401])("discards a previous account's delayed %s response without expiring the new identity", async (status) => {
  let finish!: (response: Response) => void;
  vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const request = api.workspaces.list.get(authHeaders(null));
  await vi.waitFor(() => expect(finish).toBeDefined());
  resetPrivateSession();
  const next = { ...user, id: "bob" }; useAuthStore.setState({ user: next, token: null });
  finish(new Response(JSON.stringify([{ id: "alice-private" }]), { status, headers: { "content-type": "application/json" } }));
  const result = await request;
  expect(result.data).toBeNull();
  expect(result.error).toBeTruthy();
  expect(useAuthStore.getState().user).toEqual(next);
});

beforeEach(() => vi.restoreAllMocks());

it("uses cookie credentials and the browser marker even on public Eden auth calls", async () => {
  const transport = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ user: { id: "u" } }), { headers: { "content-type": "application/json" } }));
  await api.auth.login.post({ email: "a@example.invalid", password: "secret" });
  const [, options] = transport.mock.calls[0];
  expect(options?.credentials).toBe("include");
  expect(new Headers(options?.headers).get("X-TheChat-Client")).toBe("web");
});

it("never attaches a bearer in web mode, including a stale native token", () => {
  const options = authHeaders("native-secret", { traceparent: "trace" });
  expect(options.headers).toEqual({ "X-TheChat-Client": "web", traceparent: "trace" });
});
