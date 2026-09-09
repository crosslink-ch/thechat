import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { SearchRoute } from "./search";
import { useAuthStore } from "../stores/auth";
import { useWorkspacesStore } from "../stores/workspaces";
import type { SearchMessageResult } from "@thechat/shared";
const { search, navigate, state } = vi.hoisted(() => ({
  search: vi.fn(),
  navigate: vi.fn(),
  state: { q: "launch" },
}));
vi.mock("../lib/search-api", () => ({ searchMessages: search }));
vi.mock("@tanstack/react-router", () => ({
  useSearch: () => state,
  useNavigate: () => navigate,
}));
const hit: SearchMessageResult = {
  id: "old-message",
  workspaceId: "beta",
  workspaceName: "Beta",
  conversationId: "koda",
  conversationName: "Koda",
  conversationType: "direct",
  threadId: "old-task",
  threadTitle: "Launch plan",
  senderName: "Alice",
  senderType: "human",
  content: "launch checklist from long ago",
  createdAt: "2025-01-01T12:00:00Z",
};
beforeEach(() => {
  vi.clearAllMocks();
  state.q = "launch";
  useAuthStore.setState({ token: "token" });
  useWorkspacesStore.setState({
    activeWorkspace: null,
    selectWorkspace: vi.fn().mockResolvedValue(true),
  });
  search.mockResolvedValue({ items: [hit], hasMore: false });
});
it("renders snippets, author, date and workspace, paginates without losing query or duplicate IDs", async () => {
  search
    .mockResolvedValueOnce({ items: [hit], hasMore: true })
    .mockResolvedValueOnce({
      items: [hit, { ...hit, id: "next", content: "next launch" }],
      hasMore: false,
    });
  render(<SearchRoute />);
  expect(await screen.findByText(hit.content)).toBeInTheDocument();
  expect(screen.getByText(/Alice/)).toBeInTheDocument();
  expect(screen.getByText(/Beta/)).toBeInTheDocument();
  expect(screen.getByText(/2025/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Load more results" }));
  expect(await screen.findByText("next launch")).toBeInTheDocument();
  expect(screen.getAllByText(hit.content)).toHaveLength(1);
  expect(search).toHaveBeenLastCalledWith(
    { q: "launch", limit: 20, offset: 1 },
    "token",
  );
  expect(screen.getByRole("searchbox")).toHaveValue("launch");
  fireEvent.click(screen.getByText(hit.content));
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/dm/$id",
        params: { id: "koda" },
        search: expect.objectContaining({
          threadId: "old-task",
          messageId: "old-message",
        }),
      }),
    ),
  );
});
it("keeps search in the route and does not let late old pages replace a new query", async () => {
  let resolve!: (data: {
    items: SearchMessageResult[];
    hasMore: boolean;
  }) => void;
  search.mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const view = render(<SearchRoute />);
  state.q = "new";
  search.mockResolvedValue({ items: [], hasMore: false });
  view.rerender(<SearchRoute />);
  await act(async () => resolve({ items: [hit], hasMore: false }));
  expect(screen.queryByText(hit.content)).not.toBeInTheDocument();
  expect(await screen.findByText("No matching messages")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "changed" },
  });
  fireEvent.submit(screen.getByRole("search"));
  expect(navigate).toHaveBeenCalledWith({
    to: "/search",
    search: { q: "changed" },
  });
});

it("shows the terminal result limit banner instead of offering another message page", async () => {
  search.mockResolvedValueOnce({ items: [hit], hasMore: true })
    .mockResolvedValueOnce({ items: [], hasMore: false, truncated: true });
  const view = render(<SearchRoute />);
  fireEvent.click(await screen.findByRole("button", { name: "Load more results" }));
  expect(await screen.findByText("Result limit reached. Refine your search.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Load more results" })).not.toBeInTheDocument();
  expect(screen.getByText(hit.content)).toBeInTheDocument();
  state.q = "refined";
  await act(async () => view.rerender(<SearchRoute />));
  expect(screen.queryByText("Result limit reached. Refine your search.")).not.toBeInTheDocument();
});

it.each([true, false])("renders an initially terminal message page with truncated=%s", async (truncated) => {
  search.mockResolvedValue({ items: [hit], hasMore: false, truncated });
  render(<SearchRoute />);
  expect(await screen.findByText(hit.content)).toBeInTheDocument();
  expect(Boolean(screen.queryByText("Result limit reached. Refine your search."))).toBe(truncated);
  expect(screen.queryByRole("button", { name: "Load more results" })).not.toBeInTheDocument();
});
