import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectHermesTestSocket } from "../lib/direct-hermes-test-transport";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { clearDirectHermesChats } from "../hooks/useDirectHermesChat";

const { proxyTicketPost } = vi.hoisted(() => ({ proxyTicketPost: vi.fn() }));
vi.mock("../lib/api", () => ({ api: { bots: () => ({ "hermes-rpc": { "proxy-ticket": { post: proxyTicketPost } } }) } }));
import { DirectHermesSessionsView } from "./DirectHermesSessionsView";

let socket: DirectHermesTestSocket;
let sequence = 0;
function renderView() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><DirectHermesSessionsView botId={`bot-${++sequence}`} botName="Hermes" conversationId="conversation-1" token="thechat-user-token" /></QueryClientProvider>);
}
beforeEach(() => {
  proxyTicketPost.mockResolvedValue({ data: { ticket: "A".repeat(43), expiresAt: new Date(Date.now() + 30_000), proxyUrl: "wss://test.invalid/hermes-proxy" }, error: null });
  const Native = WebSocket;
  vi.stubGlobal("WebSocket", class extends DirectHermesTestSocket {
    static OPEN = Native.OPEN; static CONNECTING = Native.CONNECTING; static CLOSED = Native.CLOSED;
    constructor() { super(); socket = this; queueMicrotask(() => this.open()); }
  });
});
afterEach(() => { cleanup(); clearDirectHermesChats(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("Direct Hermes desktop surface", () => {
  it("explains the shared gateway boundary to every chat participant", async () => {
    renderView();
    await screen.findByText("Connected");
    expect(screen.getByText("Sessions are shared with anyone granted access to this Hermes gateway.")).toBeInTheDocument();
    expect(screen.queryByText(/Private connection/)).not.toBeInTheDocument();
  });
  it("refreshes in place without inserting a loading row or resetting the session list", async () => {
    renderView();
    const row = await screen.findByRole("button", { name: "Saved A" });
    const list = row.parentElement!;
    const children = Array.from(list.children);
    list.scrollTop = 37;
    let complete!: (value: unknown) => void;
    const original = socket.handle;
    socket.handle = (method, params) => method === "session.list"
      ? new Promise(resolve => { complete = resolve; }) : original(method, params);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(screen.queryByText("Loading sessions…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refreshing sessions" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refreshing sessions" })).toHaveAttribute("aria-busy", "true");
    expect(Array.from(list.children)).toEqual(children);
    expect(screen.getByRole("button", { name: "Saved A" })).toBe(row);
    expect(list.scrollTop).toBe(37);
    await waitFor(() => expect(complete).toBeTypeOf("function"));
    await act(async () => complete({ sessions: [{ id: "saved-a", title: "Saved A" }, { id: "saved-b", title: "Saved B" }] }));
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Saved A" })).toBe(row);
    expect(list.scrollTop).toBe(37);
  });
  it("connects once under StrictMode effect replay using the real client and transport", async () => {
    render(<StrictMode><DirectHermesSessionsView botId={`strict-${++sequence}`} botName="Hermes" conversationId="conversation-1" token="thechat-user-token" /></StrictMode>);
    await screen.findByText("Connected");
    expect(proxyTicketPost).toHaveBeenCalledTimes(1);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    const input = await screen.findByRole("textbox", { name: "Message Hermes" });
    fireEvent.change(input, { target: { value: "Strict mode prompt" } }); fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(input).toHaveValue(""));
    expect(socket.calls.filter(call => call.method === "prompt.submit")).toHaveLength(1);
  });
  it("offers explicit approval and clarification controls and truthful unsupported-interaction guidance", async () => {
    renderView(); await screen.findByText("Connected");
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    await screen.findByRole("textbox", { name: "Message Hermes" });
    socket.handle = method => method === "approval.respond" ? { resolved: 1 } : { status: "ok" };
    act(() => socket.event("approval.request", { request_id: "a1", command: "rm example", description: "Confirm deletion" }));
    expect(screen.getByText("rm example")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Allow once" })).not.toBeInTheDocument());
    act(() => socket.event("clarify.request", { request_id: "q1", question: "Which folder?", choices: ["src", "test"] }));
    fireEvent.change(screen.getByRole("textbox", { name: "Answer" }), { target: { value: "src" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
    await waitFor(() => expect(socket.calls.at(-1)).toMatchObject({ method: "clarify.respond", params: { request_id: "q1", answer: "src" } }));
    act(() => socket.event("secret.request", { request_id: "s1", name: "API key" }));
    expect(screen.getByText(/This interaction requires the Hermes app/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
  });
  it("keeps a running session and draft alive across navigation away and back", async () => {
    const props = { botId: `bot-${++sequence}`, botName: "Hermes", conversationId: "conversation-1", token: "thechat-user-token" };
    const view = render(<DirectHermesSessionsView {...props} />);
    await screen.findByText("Connected");
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    const input = await screen.findByRole("textbox", { name: "Message Hermes" });
    fireEvent.change(input, { target: { value: "Run" } }); fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(input).toHaveValue(""));
    fireEvent.change(input, { target: { value: "My next draft" } });
    const liveSocket = socket;
    view.unmount();
    expect(liveSocket.readyState).toBe(WebSocket.OPEN);
    act(() => liveSocket.event("message.complete", { text: "Finished while away" }));
    render(<DirectHermesSessionsView {...props} />);
    expect(await screen.findByText("Finished while away")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message Hermes" })).toHaveValue("My next draft");
    expect(socket).toBe(liveSocket);
    expect(liveSocket.calls.filter(call => call.method === "prompt.submit")).toHaveLength(1);
  });
  it("shows a Sessions sidebar, sends on the direct tunnel, renders live tools and a final Markdown answer", async () => {
    renderView();
    const sidebar = await screen.findByRole("complementary", { name: "Sessions" });
    expect(within(sidebar).getByRole("button", { name: /Saved A/ })).toBeInTheDocument();
    expect(within(sidebar).getByRole("button", { name: /Saved A/ })).toHaveAttribute("aria-pressed", "false");
    expect(within(sidebar).getByRole("button", { name: /Saved B/ })).toHaveAttribute("aria-pressed", "false");
    expect(proxyTicketPost).toHaveBeenCalledWith({ conversationId: "conversation-1" }, { fetch: { signal: expect.any(AbortSignal) }, headers: { authorization: "Bearer thechat-user-token" } });
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    const composer = await screen.findByRole("textbox", { name: "Message Hermes" });
    await waitFor(() => expect(composer).not.toBeDisabled());
    fireEvent.change(composer, { target: { value: "Inspect the project" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(composer).toHaveValue(""));
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
    act(() => socket.event("tool.start", { tool_id: "t1", name: "terminal", context: "pwd", args: { command: "pwd" } }));
    expect(screen.getByText("terminal")).toBeInTheDocument();
    act(() => socket.event("tool.complete", { tool_id: "t1", name: "terminal", result: { output: "/project" } }));
    expect(screen.getByText(/\/project/)).toBeInTheDocument();
    act(() => socket.event("message.complete", { text: "The project is **ready**." }));
    expect(screen.getByText("ready").tagName).toBe("STRONG");
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  });
});
