import { act, render, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../platform/environment", () => ({ isWeb: true }));
import { useAuthStore } from "../stores/auth";
import { useConversationDetail } from "./useConversationDetail";
import { useBotRuntime } from "./useBotRuntime";
import { useConversationThreads } from "./useConversationThreads";
import { useChannelChat } from "./useChannelChat";
import { SharedMessageAttachments } from "../components/SharedMessageAttachments";
const user = { id: "alice", name: "Alice", email: "a@example.invalid", type: "human", avatar: null } as const;
afterEach(() => vi.restoreAllMocks());
it("enables shared detail, history, runtime and task creation with cookie identity", async () => {
  useAuthStore.setState({ user, token: null, loading: false });
  const requests: { path: string; method?: string; headers: Headers; credentials?: string }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, options) => {
    const path = new URL(String(input)).pathname;
    requests.push({ path, method: options?.method, headers: new Headers(options?.headers), credentials: options?.credentials });
    const value = path.includes("threads") ? (options?.method === "POST" ? { id: "task-1", conversationId: "chat", title: "Task" } : { items: [], nextCursor: null }) : path.includes("bot-runtime") ? { invocations: [], events: [] } : path.includes("messages") ? [] : { id: "chat", type: "dm" };
    return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  const mounted = renderHook(() => {
    useConversationDetail("chat", null);
    useBotRuntime("chat", null);
    useChannelChat({ conversationId: "chat", token: null, selfUser: user, wsSendMessage: vi.fn() });
    return useConversationThreads("chat", null);
  }, { wrapper });
  await waitFor(() => expect(requests).toHaveLength(4));
  await act(async () => { expect(await mounted.result.current.createThread({ title: "Task" })).toMatchObject({ id: "task-1" }); });
  expect(requests).toHaveLength(5);
  for (const request of requests) {
    expect(request.headers.get("authorization")).toBeNull();
    expect(request.headers.get("X-TheChat-Client")).toBe("web");
    expect(request.credentials).toBe("include");
  }
  mounted.unmount(); queryClient.clear();
});
it("renders authorized file attachments with a null browser token", () => {
  useAuthStore.setState({ user, token: null, loading: false });
  const view = render(<SharedMessageAttachments attachments={[{ id: "file", fileName: "report.txt", kind: "file", mediaType: "text/plain", sizeBytes: 5 } as never]} />);
  expect(view.getByText("report.txt")).toBeVisible();
});
