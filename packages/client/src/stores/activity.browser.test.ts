import { beforeEach, expect, it, vi } from "vitest";
import type { ActivitySnapshot } from "@thechat/shared";

vi.mock("../platform/environment", () => ({ isWeb: true }));
const { activityGet, readPost, readAllPost, conversationsRoute } = vi.hoisted(() => ({
  activityGet: vi.fn(), readPost: vi.fn(), readAllPost: vi.fn(), conversationsRoute: vi.fn(),
}));
vi.mock("../lib/api", () => ({ api: { activity: {
  get: activityGet, conversations: conversationsRoute, "read-all": { post: readAllPost },
} } }));
import { useAuthStore } from "./auth";
import { useActivityStore } from "./activity";
import { resetPrivateSession } from "../lib/session-boundary";

const user = { id: "alice", name: "Alice", email: "alice@example.invalid", avatar: null, type: "human" } as const;
const empty: ActivitySnapshot = { items: [], totalUnreadMessages: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ token: null, user, loading: false });
  useActivityStore.getState().reset();
  conversationsRoute.mockReturnValue({ read: { post: readPost } });
  for (const mock of [activityGet, readPost, readAllPost]) mock.mockResolvedValue({ data: empty, error: null });
});

it("loads and marks Activity through a cookie identity without a bearer token", async () => {
  await useActivityStore.getState().fetchActivity();
  await useActivityStore.getState().markConversationRead("conversation-1", ["message-1"]);
  await useActivityStore.getState().markAllRead();
  const auth = { headers: { "X-TheChat-Client": "web" } };
  expect(activityGet).toHaveBeenCalledWith(auth);
  expect(readPost).toHaveBeenCalledWith({ messageIds: ["message-1"] }, auth);
  expect(readAllPost).toHaveBeenCalledWith({}, auth);
});

it.each(["fetch", "read", "read-all"] as const)(
  "fences a delayed %s response across a cookie account change",
  async (operation) => {
    let finish!: (value: unknown) => void;
    const mock = operation === "fetch" ? activityGet : operation === "read" ? readPost : readAllPost;
    mock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const store = useActivityStore.getState();
    const pending = operation === "fetch" ? store.fetchActivity()
      : operation === "read" ? store.markConversationRead("conversation-1") : store.markAllRead();
    expect(finish).toBeDefined();
    resetPrivateSession();
    useAuthStore.setState({ user: { ...user, id: "bob" } });
    activityGet.mockClear();
    finish({ data: { items: [], totalUnreadMessages: 9 }, error: null });
    await pending;
    expect(useActivityStore.getState().totalUnreadMessages).toBe(0);
    expect(activityGet).not.toHaveBeenCalled();
  },
);

it("clears cached Activity at an authoritative session reset", () => {
  useActivityStore.setState({ totalUnreadMessages: 9, error: "old account", loading: true });
  resetPrivateSession();
  expect(useActivityStore.getState()).toMatchObject({ ...empty, error: null, loading: false });
});
