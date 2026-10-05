import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RootView } from "./__root";
import { useWebSocketStore } from "../stores/websocket";
import { useWorkspacesStore } from "../stores/workspaces";

vi.mock("#platform-shell", () => ({ PlatformDialogs: () => null, PlatformTitlebar: () => <div>Titlebar</div>, PlatformUpdateToast: () => null, usePlatformLifecycle: () => {} }));
vi.mock("@tanstack/react-router", () => ({ Outlet: () => <div>Conversation content</div>, useNavigate: () => vi.fn(), useRouterState: () => "/channel/a" }));
vi.mock("../components/Sidebar", () => ({ Sidebar: () => <button>General channel</button> }));
vi.mock("../components/ChatHeader", () => ({ ChatHeader: () => <div>Header</div> }));
vi.mock("../CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("../components/AuthModal", () => ({ AuthModal: () => null, AuthOnboarding: () => <div>Log in</div> }));
vi.mock("../components/WorkspaceModal", () => ({ WorkspaceModal: () => null, openWorkspaceModal: vi.fn() }));
vi.mock("../components/ChannelModal", () => ({ ChannelModal: () => null }));
vi.mock("../components/HermesBotModal", () => ({ HermesBotModal: () => null }));

const initializeWorkspaces = useWorkspacesStore.getState().initialize;
const connectWebSocket = useWebSocketStore.getState().connect;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  useWorkspacesStore.getState().reset();
  useWorkspacesStore.setState({ initialize: initializeWorkspaces });
  useWebSocketStore.setState({ connected: false, reconnecting: false, connect: connectWebSocket });
});
afterEach(() => vi.restoreAllMocks());

it("updates and clears offline status on network events without hiding the route", () => {
  const online = vi.spyOn(navigator, "onLine", "get");
  const mounted = render(<RootView authLoading={false} authenticated />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  act(() => { online.mockReturnValue(false); window.dispatchEvent(new Event("offline")); });
  expect(screen.getByRole("status")).toHaveTextContent("You're offline");
  expect(screen.getByText("Conversation content")).toBeInTheDocument();
  act(() => { online.mockReturnValue(true); window.dispatchEvent(new Event("online")); });
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  mounted.unmount();
  act(() => window.dispatchEvent(new Event("offline")));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("refreshes workspaces after network recovery, but never starts another request while loading", () => {
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  const initialize = vi.spyOn(useWorkspacesStore.getState(), "initialize").mockResolvedValue();
  render(<RootView authLoading={false} authenticated />);
  act(() => { online.mockReturnValue(true); window.dispatchEvent(new Event("online")); });
  expect(initialize).toHaveBeenCalledOnce();
  act(() => window.dispatchEvent(new Event("online")));
  expect(initialize).toHaveBeenCalledOnce();
  act(() => { online.mockReturnValue(false); window.dispatchEvent(new Event("offline")); useWorkspacesStore.setState({ loading: true }); });
  act(() => { online.mockReturnValue(true); window.dispatchEvent(new Event("online")); });
  expect(initialize).toHaveBeenCalledOnce();
});

it("refreshes after authenticated realtime recovery rather than the initial socket connection", () => {
  const initialize = vi.spyOn(useWorkspacesStore.getState(), "initialize").mockResolvedValue();
  render(<RootView authLoading={false} authenticated />);
  act(() => useWebSocketStore.setState({ connected: true, reconnecting: false }));
  expect(initialize).not.toHaveBeenCalled();
  act(() => useWebSocketStore.setState({ connected: false, reconnecting: true }));
  act(() => useWebSocketStore.setState({ connected: true, reconnecting: false }));
  expect(initialize).toHaveBeenCalledOnce();
});

it.each([
  { authLoading: true, authenticated: true },
  { authLoading: false, authenticated: false },
])("does not retry private workspace data behind an auth gate: %j", (props) => {
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  const initialize = vi.spyOn(useWorkspacesStore.getState(), "initialize").mockResolvedValue();
  const mounted = render(<RootView {...props} />);
  act(() => { online.mockReturnValue(true); window.dispatchEvent(new Event("online")); });
  act(() => useWebSocketStore.setState({ connected: false, reconnecting: true }));
  act(() => useWebSocketStore.setState({ connected: true, reconnecting: false }));
  expect(initialize).not.toHaveBeenCalled();
  mounted.unmount();
  act(() => { window.dispatchEvent(new Event("offline")); window.dispatchEvent(new Event("online")); });
  expect(initialize).not.toHaveBeenCalled();
});

it("gives offline status priority over server failures and disables workspace retry offline", () => {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  useWebSocketStore.setState({ reconnecting: true });
  useWorkspacesStore.setState({ error: "Unable to load workspaces." });
  render(<RootView authLoading={false} authenticated />);
  expect(screen.getByRole("status")).toHaveTextContent("You're offline");
  expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
});

it("does not label ordinary workspace loading as a connection failure", () => {
  useWorkspacesStore.setState({ loading: true });
  render(<RootView authLoading={false} authenticated />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("shows realtime reconnection without calling an initial connection Internet offline", () => {
  render(<RootView authLoading={false} authenticated />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  act(() => useWebSocketStore.setState({ connected: false, reconnecting: true }));
  expect(screen.getByRole("status")).toHaveTextContent("Connection lost. Reconnecting");
  expect(screen.getByRole("status")).not.toHaveTextContent("You're offline");
  act(() => useWebSocketStore.setState({ connected: true, reconnecting: false }));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("keeps workspace failures visible across routes and retries without restarting the socket", async () => {
  useWorkspacesStore.setState({ error: "Unable to load workspaces." });
  const initialize = vi.spyOn(useWorkspacesStore.getState(), "initialize").mockImplementation(async () => {
    useWorkspacesStore.setState({ loading: true });
  });
  const connect = vi.spyOn(useWebSocketStore.getState(), "connect");
  const mounted = render(<RootView authLoading={false} authenticated routeKey="/channel/a" />);
  expect(screen.getByRole("status")).toHaveTextContent("Unable to load workspaces.");
  expect(screen.getByRole("status")).not.toHaveTextContent("You're offline");
  mounted.rerender(<RootView authLoading={false} authenticated routeKey="/dm/b" />);
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(initialize).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Retrying..." })).toBeDisabled();
  expect(connect).not.toHaveBeenCalled();
  act(() => useWorkspacesStore.setState({ error: null, loading: false }));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it.each([
  { authLoading: false, authenticated: true },
  { authLoading: true, authenticated: true },
  { authLoading: false, authenticated: false },
])("shows initial offline status above the shell and auth/loading gates: %j", (props) => {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  render(<RootView {...props} />);
  const status = screen.getByRole("status");
  expect(status).toHaveTextContent("You're offline");
  expect(status).toHaveAttribute("aria-live", "polite");
  expect(status).toHaveAttribute("aria-atomic", "true");
  expect(screen.getByText("Titlebar").compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
