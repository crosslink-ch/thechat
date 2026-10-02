import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BotAppearance, ConversationDetail, WorkspaceWithDetails } from "@thechat/shared";
import { useConversationDetail } from "./useConversationDetail";
import { useWorkspacesStore } from "../stores/workspaces";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../lib/api", () => ({
  api: { conversations: { detail: () => ({ get: mocks.get }) } },
}));

const date = "2026-01-01T00:00:00.000Z";
const participant = {
  userId: "bot-user-1", role: "member" as const, joinedAt: date,
  user: { id: "bot-user-1", name: "Assistant", type: "bot" as const, email: null, avatar: null },
  bot: { id: "bot-1", kind: "hermes" as const, avatar: { shape: "ghost", color: "#00B894" } as BotAppearance },
};
const detail: ConversationDetail = {
  id: "dm-1", type: "direct", workspaceId: null, name: null, title: null,
  participants: [participant],
};
const selectAppearance = (avatar: BotAppearance) => useWorkspacesStore.setState({
  activeWorkspace: {
    id: "workspace-a", name: "Workspace A", createdAt: date, updatedAt: date,
    channels: [], members: [{ ...participant, bot: { ...participant.bot, avatar } }],
  },
});

beforeEach(() => {
  mocks.get.mockReset();
  mocks.get.mockResolvedValue({ data: detail, error: null });
  useWorkspacesStore.setState({ activeWorkspace: null });
});

describe("useConversationDetail bot identity", () => {
  it("reconciles live bot styles into the conversation before unrelated workspace switches", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result, unmount } = renderHook(() => useConversationDetail("dm-1", "token-1"), { wrapper });
    try {
      await waitFor(() => expect(result.current.data?.participants[0].bot?.avatar?.shape).toBe("ghost"));
      act(() => selectAppearance({ shape: "minimal", color: "#00B894" }));
      await waitFor(() => expect(result.current.data?.participants[0].bot?.avatar?.shape).toBe("minimal"));
      act(() => useWorkspacesStore.setState({
        activeWorkspace: { id: "workspace-b", members: [] } as unknown as WorkspaceWithDetails,
      }));
      expect(result.current.data?.participants[0].bot?.avatar?.shape).toBe("minimal");
      act(() => selectAppearance({ shape: "cat", color: "#3498DB" }));
      await waitFor(() => expect(result.current.data?.participants[0].bot?.avatar).toEqual({ shape: "cat", color: "#3498DB" }));
      act(() => useWorkspacesStore.setState({ activeWorkspace: null }));
      expect(result.current.data?.participants[0].bot?.avatar?.shape).toBe("cat");
      expect(mocks.get).toHaveBeenCalledOnce();
    } finally {
      unmount();
      client.clear();
    }
  });
});
