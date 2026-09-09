import { rememberDestination } from "./lib/search";
import { API_URL } from "./lib/api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  CommandPalette,
  closePalette,
  togglePalette,
  openPaletteInCommandMode,
} from "./CommandPalette";
import { useCommandsStore } from "./commands";
import { useAuthStore } from "./stores/auth";
import { useWorkspacesStore } from "./stores/workspaces";
import type { SearchDestination } from "@thechat/shared";

const { jump, messages, navigate } = vi.hoisted(() => ({
  jump: vi.fn(),
  messages: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("./lib/search-api", () => ({
  searchJump: jump,
  searchMessages: messages,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

const koda: SearchDestination = {
  id: "dm:koda",
  kind: "dm",
  conversationId: "koda",
  conversationType: "direct",
  threadId: null,
  workspaceId: "beta",
  workspaceName: "Beta",
  title: "Koda",
  conversationName: "Koda",
  participantType: "bot",
  updatedAt: "2026-09-01",
};
const general: SearchDestination = {
  ...koda,
  id: "channel:general",
  kind: "channel",
  conversationId: "general",
  conversationType: "group",
  title: "general",
  participantType: null,
};
const task: SearchDestination = {
  ...koda,
  id: "task:old",
  kind: "task",
  threadId: "old",
  title: "Release checklist",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function open() {
  render(<CommandPalette />);
  await act(async () => togglePalette());
}
function type(query: string) {
  fireEvent.change(screen.getByRole("combobox"), { target: { value: query } });
}

beforeEach(() => {
  closePalette();
  vi.clearAllMocks();
  localStorage.clear();
  jump.mockResolvedValue({ items: [koda, general, task], hasMore: false });
  messages.mockResolvedValue({ items: [], hasMore: false });
  useAuthStore.setState({
    token: "token",
    user: {
      id: "alice",
      name: "Alice",
      email: "alice@example.test",
      type: "human",
      avatar: null,
    },
  });
  useWorkspacesStore.setState({
    activeWorkspace: null,
    selectWorkspace: vi.fn().mockResolvedValue(true),
  });
  useCommandsStore.getState().setCommands([
    {
      id: "settings",
      label: "Settings",
      execute: vi.fn(),
      keybinding: null,
      shortcut: null,
    },
  ]);
});

describe("Jump to palette", () => {
  it("defaults to all-workspace destinations with labels, task titles and no commands", async () => {
    await open();
    expect(await screen.findByText("Koda")).toBeInTheDocument();
    expect(screen.getByText("Release checklist")).toBeInTheDocument();
    expect(screen.getAllByText(/Beta/).length).toBe(3);
    expect(screen.queryByText("Settings")).not.toBeInTheDocument();
    expect(jump).toHaveBeenCalledWith(
      expect.objectContaining({ q: "", kind: "all" }),
      "token",
    );
    type("Koda");
    await waitFor(() =>
      expect(jump).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: "Koda", kind: "all" }),
        "token",
      ),
    );
    fireEvent.click(await screen.findByText("Koda"));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "/dm/$id",
          params: { id: "koda" },
          search: expect.objectContaining({
            threadId: undefined,
            messageId: undefined,
          }),
        }),
      ),
    );
    expect(useWorkspacesStore.getState().selectWorkspace).toHaveBeenCalledWith(
      "beta",
      expect.any(Function),
    );
  });
  it("clickable filters match @, #, ? and > without dropping query", async () => {
    await open();
    type("Koda");
    fireEvent.click(screen.getByRole("button", { name: "DMs" }));
    expect(screen.getByRole("combobox")).toHaveValue("@ Koda");
    await waitFor(() =>
      expect(jump).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: "Koda", kind: "dm" }),
        "token",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Channels" }));
    expect(screen.getByRole("combobox")).toHaveValue("# Koda");
    fireEvent.click(screen.getByRole("button", { name: "Messages" }));
    expect(screen.getByRole("combobox")).toHaveValue("? Koda");
    await waitFor(() =>
      expect(messages).toHaveBeenCalledWith(
        expect.objectContaining({ q: "Koda" }),
        "token",
      ),
    );
    act(() => openPaletteInCommandMode());
    expect(screen.getByRole("combobox")).toHaveValue(">");
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });
  it("never navigates on a failed workspace switch", async () => {
    useWorkspacesStore.setState({
      selectWorkspace: vi.fn().mockResolvedValue(false),
    });
    await open();
    fireEvent.click(await screen.findByText("Koda"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Could not open/,
    );
    expect(navigate).not.toHaveBeenCalled();
  });
  it("ignores old requests after query, close and account changes", async () => {
    const old = deferred<{ items: SearchDestination[]; hasMore: boolean }>();
    jump.mockReturnValueOnce(old.promise);
    await open();
    await waitFor(() => expect(jump).toHaveBeenCalledTimes(1));
    jump.mockResolvedValue({ items: [general], hasMore: false });
    type("new");
    await act(async () => old.resolve({ items: [koda], hasMore: false }));
    await waitFor(() =>
      expect(screen.queryByText("Koda")).not.toBeInTheDocument(),
    );
    const switching = deferred<boolean>();
    useWorkspacesStore.setState({
      selectWorkspace: vi.fn(() => switching.promise),
    });
    fireEvent.click(await screen.findByText("general"));
    act(() => closePalette());
    act(() => useAuthStore.setState({ user: null, token: null }));
    await act(async () => switching.resolve(true));
    expect(navigate).not.toHaveBeenCalled();
  });
  it("keeps keyboard selection by ID when command results reorder; IME does not submit", async () => {
    const a = {
      id: "a",
      label: "Alpha",
      execute: vi.fn(),
      shortcut: null,
      keybinding: null,
    };
    const b = { ...a, id: "b", label: "Beta", execute: vi.fn() };
    useCommandsStore.getState().setCommands([a, b]);
    await open();
    type(">");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    act(() => useCommandsStore.getState().setCommands([b, a]));
    fireEvent.keyDown(screen.getByRole("combobox"), {
      key: "Enter",
      isComposing: true,
    });
    expect(b.execute).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(b.execute).toHaveBeenCalledOnce();
    expect(a.execute).not.toHaveBeenCalled();
  });
  it("Escape restores original focus and contains accessible modal focus", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    await open();
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(trigger).toHaveFocus();
    trigger.remove();
  });
});

it("fits the app visual viewport when the mobile keyboard reduces its height", async () => {
  await open();
  const panel = screen.getByTestId("palette-panel");
  expect(panel.parentElement).toHaveStyle({
    height: "var(--app-viewport-height, 100dvh)",
    top: "var(--app-viewport-top, 0px)",
  });
  expect(panel).toHaveStyle({ maxHeight: "100%" });
});
it("message preview selection opens the exact message and View all preserves the query", async () => {
  messages.mockResolvedValue({
    items: [
      {
        id: "old",
        workspaceId: "beta",
        workspaceName: "Beta",
        conversationId: "general",
        conversationName: "general",
        conversationType: "group",
        threadId: null,
        threadTitle: null,
        senderName: "Alice",
        senderType: "human",
        content: "launch from last year",
        createdAt: "2025-01-01T00:00:00Z",
      },
    ],
    hasMore: true,
  });
  await open();
  type("? launch");
  fireEvent.click(await screen.findByText("launch from last year"));
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/channel/$id",
        search: expect.objectContaining({ messageId: "old" }),
      }),
    ),
  );
  await act(async () => togglePalette());
  type("? launch");
  fireEvent.click(screen.getByText("View all results"));
  expect(navigate).toHaveBeenLastCalledWith({
    to: "/search",
    search: { q: "launch" },
  });
});

it("navigates when the real workspace switch updates the ranking hint before resolving", async () => {
  useWorkspacesStore.setState({
    selectWorkspace: vi.fn(async () => {
      useWorkspacesStore.setState({
        activeWorkspace: {
          id: "beta",
          name: "Beta",
          createdAt: "2026-09-01",
          updatedAt: "2026-09-01",
          channels: [],
          members: [],
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      return true;
    }),
  });
  await open();
  fireEvent.click(await screen.findByText("Koda"));
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/dm/$id", params: { id: "koda" } }),
    ),
  );
});

it("reports an empty message preview without calling it a missing destination", async () => {
  await open();
  type("? absent");
  expect(await screen.findByText("No matching messages")).toBeInTheDocument();
  expect(screen.getByText("View all results")).toBeInTheDocument();
});
it("fences a pending navigation after an account change even without closing manually", async () => {
  const pending = deferred<boolean>();
  useWorkspacesStore.setState({
    selectWorkspace: vi.fn(() => pending.promise),
  });
  await open();
  fireEvent.click(await screen.findByText("Koda"));
  act(() =>
    useAuthStore.setState({
      user: {
        id: "bob",
        email: "bob@example.test",
        name: "Bob",
        type: "human",
        avatar: null,
      },
    }),
  );
  await act(async () => pending.resolve(true));
  expect(navigate).not.toHaveBeenCalled();
});
it("searches a cookie-authenticated user with a null bearer token", async () => {
  useAuthStore.setState({ token: null });
  await open();
  expect(await screen.findByText("Koda")).toBeInTheDocument();
  expect(jump).toHaveBeenCalledWith(expect.objectContaining({ q: "" }), null);
});

it("offers Tasks without inventing a prefix and paginates destinations beyond the first page", async () => {
  jump
    .mockResolvedValueOnce({ items: [koda], hasMore: true })
    .mockResolvedValueOnce({ items: [general], hasMore: false });
  await open();
  fireEvent.click(await screen.findByText("Load more destinations"));
  expect(await screen.findByText("general")).toBeInTheDocument();
  expect(screen.getByText("Koda")).toBeInTheDocument();
  expect(jump).toHaveBeenLastCalledWith(
    expect.objectContaining({ offset: 1, q: "", kind: "all" }),
    "token",
  );
  expect(screen.queryByText("Load more destinations")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
  type("Release");
  await waitFor(() =>
    expect(jump).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 0, q: "Release", kind: "task" }),
      "token",
    ),
  );
  expect(screen.getByRole("combobox")).toHaveValue("Release");
  fireEvent.click(screen.getByRole("button", { name: "All" }));
  await waitFor(() =>
    expect(jump).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: "Release", kind: "all" }),
      "token",
    ),
  );
});

it("debounces rapid remote destination and message queries", async () => {
  vi.useFakeTimers();
  try {
    await open();
    jump.mockClear();
    type("K");
    type("Ko");
    type("Koda");
    expect(jump).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(jump).toHaveBeenCalledTimes(1);
    expect(jump).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: "Koda" }),
      "token",
    );
    type("? l");
    type("? la");
    type("? launch");
    expect(messages).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(messages).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps modal focus when a delayed composer mount attempts to steal it", async () => {
  const composer = document.createElement("textarea");
  document.body.appendChild(composer);
  try {
    await open();
    type(">");
    const input = screen.getByRole("combobox");
    expect(input).toHaveFocus();
    await act(async () => {
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          composer.focus();
          resolve();
        }, 0),
      );
    });
    expect(input).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(
      useCommandsStore.getState().commands[0].execute,
    ).toHaveBeenCalledOnce();
  } finally {
    composer.remove();
  }
});
it("distinguishes Bot DM from human DM in destination labels", async () => {
  jump.mockResolvedValue({
    items: [
      koda,
      { ...koda, id: "human", participantType: "human", title: "Alice" },
    ],
    hasMore: false,
  });
  await open();
  expect(await screen.findByText("Beta · Bot DM")).toBeInTheDocument();
  expect(screen.getByText("Beta · DM")).toBeInTheDocument();
});

it("sends only this account and server recent IDs so old visited destinations can be ranked before the limit", async () => {
  const mine = "dm:00000000-0000-4000-8000-000000000001";
  rememberDestination(API_URL, "alice", mine);
  rememberDestination(
    API_URL,
    "bob",
    "dm:00000000-0000-4000-8000-000000000002",
  );
  rememberDestination(
    "https://other.example",
    "alice",
    "dm:00000000-0000-4000-8000-000000000003",
  );
  rememberDestination(API_URL, "alice", "invalid cached label");
  await open();
  await waitFor(() =>
    expect(jump).toHaveBeenCalledWith(
      expect.objectContaining({ q: "", recentIds: mine }),
      "token",
    ),
  );
  type("Koda");
  await waitFor(() =>
    expect(jump).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: "Koda" }),
      "token",
    ),
  );
  expect(jump.mock.calls.at(-1)?.[0]).not.toHaveProperty("recentIds");
});

it.each(["cancelled", "rejected"])("does not publish a %s workspace selection error into a newer query", async (outcome) => {
  const pending = deferred<boolean>();
  useWorkspacesStore.setState({
    selectWorkspace: vi.fn(async () => {
      await pending.promise;
      if (outcome === "rejected") throw new Error("Stale access failure");
      return false;
    }),
  });
  await open();
  fireEvent.click(await screen.findByText("Koda"));
  type("new query");
  await act(async () => pending.resolve(false));
  expect(screen.getByRole("combobox")).toHaveValue("new query");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(navigate).not.toHaveBeenCalled();
});

it("shows the terminal result limit banner after loading the last destination page", async () => {
  jump.mockResolvedValueOnce({ items: [koda], hasMore: true })
    .mockResolvedValueOnce({ items: [general], hasMore: false, truncated: true });
  await open();
  fireEvent.click(await screen.findByText("Load more destinations"));
  expect(await screen.findByText("general")).toBeInTheDocument();
  expect(screen.getByText("Result limit reached. Refine your search.")).toBeInTheDocument();
  expect(screen.queryByText("Load more destinations")).not.toBeInTheDocument();
  type("refined");
  expect(screen.queryByText("Result limit reached. Refine your search.")).not.toBeInTheDocument();
});

it.each([true, false])("renders an initially terminal destination page with truncated=%s", async (truncated) => {
  jump.mockResolvedValue({ items: [koda], hasMore: false, truncated });
  await open();
  expect(await screen.findByText("Koda")).toBeInTheDocument();
  expect(Boolean(screen.queryByText("Result limit reached. Refine your search."))).toBe(truncated);
  expect(screen.queryByText("Load more destinations")).not.toBeInTheDocument();
});
