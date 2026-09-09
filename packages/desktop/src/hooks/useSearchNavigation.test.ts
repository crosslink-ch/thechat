import { renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { SearchDestination, SearchMessageResult } from "@thechat/shared";
import { useSearchNavigation } from "./useSearchNavigation";

const { navigate, focus, selectWorkspace } = vi.hoisted(() => ({
  navigate: vi.fn().mockResolvedValue(undefined),
  focus: vi.fn(),
  selectWorkspace: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("../stores/auth", () => ({
  useAuthStore: { getState: () => ({ user: { id: "alice" }, token: "token" }) },
}));
vi.mock("../stores/workspaces", () => ({
  useWorkspacesStore: { getState: () => ({ activeWorkspace: { id: "workspace" }, selectWorkspace }) },
}));
vi.mock("../lib/session-boundary", () => ({ sessionGeneration: () => 0 }));
vi.mock("../stores/input-focus", () => ({ requestInputBarFocus: focus }));
beforeEach(() => vi.clearAllMocks());

const task: SearchDestination = {
  id: "task:thread", kind: "task", conversationId: "parent", conversationType: "group",
  threadId: "thread", workspaceId: "workspace", workspaceName: "Workspace",
  title: "Task", conversationName: "Parent", participantType: null, updatedAt: "2026-09-01",
};

it.each([
  ["group", "/channel/$id"],
  ["direct", "/dm/$id"],
] as const)("opens a %s task in its parent route", async (conversationType, to) => {
  const { result } = renderHook(() => useSearchNavigation());
  await expect(result.current({ ...task, conversationType })).resolves.toBe(true);
  expect(navigate).toHaveBeenCalledWith({
    to, params: { id: "parent" },
    search: { threadId: "thread", messageId: undefined, jump: expect.any(String) },
  });
  expect(focus).toHaveBeenCalledOnce();
});

it.each([
  ["group", "/channel/$id"],
  ["direct", "/dm/$id"],
] as const)("opens a %s task message in its parent context", async (conversationType, to) => {
  const message: SearchMessageResult = {
    id: "message", conversationId: "parent", conversationType, threadId: "thread",
    workspaceId: "workspace", workspaceName: "Workspace", conversationName: "Parent",
    threadTitle: "Task", senderName: "Alice", senderType: "human", content: "Task reply", createdAt: "2026-09-01",
  };
  const { result } = renderHook(() => useSearchNavigation());
  await result.current(message);
  expect(navigate).toHaveBeenCalledWith({
    to, params: { id: "parent" },
    search: { threadId: "thread", messageId: "message", jump: expect.any(String) },
  });
});

it("silently cancels a workspace selection that resolves false after the intent changes", async () => {
  let finish!: (value: boolean) => void;
  selectWorkspace.mockReturnValue(new Promise<boolean>((resolve) => { finish = resolve; }));
  let current = true;
  const { result } = renderHook(() => useSearchNavigation());
  const pending = result.current({ ...task, workspaceId: "other" }, () => current);
  current = false;
  finish(false);
  await expect(pending).resolves.toBe(false);
  expect(navigate).not.toHaveBeenCalled();
  expect(focus).not.toHaveBeenCalled();
});
