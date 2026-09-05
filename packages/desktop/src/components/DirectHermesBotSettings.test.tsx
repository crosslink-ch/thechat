import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectHermesBotSettings } from "./DirectHermesBotSettings";

const mocks = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), bots: vi.fn() }));
vi.mock("../lib/api", () => ({ api: { bots: mocks.bots } }));

const settings = {
  botId: "bot-a", endpoint: "wss://hermes.example.com/api/ws", gatewayTokenConfigured: true,
  allowedUserIds: [] as string[], eligibleUsers: [{ id: "human-a", name: "Alice" }, { id: "human-b", name: "Bob" }], revision: "revision-1",
};
const auth = { headers: { authorization: "Bearer user-token" } };
const save = () => screen.getByRole("button", { name: "Save Direct Hermes settings" });
const acknowledge = () => screen.getByRole("checkbox", { name: /I understand.*all sessions and runtime controls/i });
function renderPanel() { return render(<DirectHermesBotSettings botId="bot-a" token="user-token" />); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.bots.mockReturnValue({ "hermes-rpc": { settings: { get: mocks.get, patch: mocks.patch } } });
  mocks.get.mockResolvedValue({ data: settings, error: null });
  mocks.patch.mockResolvedValue({ data: settings, error: null });
});
afterEach(cleanup);

describe("DirectHermesBotSettings", () => {
  it("ignores a late settings load for the previous bot and shows only configured status without persisting a secret", async () => {
    const pending = deferred<unknown>();
    mocks.get.mockReturnValueOnce(pending.promise);
    const panel = renderPanel();
    expect(screen.getByRole("status")).toHaveTextContent(/Loading/);
    mocks.get.mockResolvedValueOnce({ data: { ...settings, botId: "bot-b", gatewayTokenConfigured: false, endpoint: "https://bot-b.example.com" }, error: null });
    panel.rerender(<DirectHermesBotSettings botId="bot-b" token="user-token" />);
    expect(await screen.findByText("Gateway token not configured")).toBeInTheDocument();
    const storage = vi.spyOn(Storage.prototype, "setItem");
    fireEvent.change(screen.getByLabelText("Replacement gateway token"), { target: { value: "draft-only-secret" } });
    expect(storage).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /copy|reveal/i })).not.toBeInTheDocument();
    await act(async () => pending.resolve({ data: settings, error: null }));
    expect(screen.getByLabelText("Gateway endpoint")).toHaveValue("https://bot-b.example.com");
    expect(screen.getByLabelText("Replacement gateway token")).toHaveValue("draft-only-secret");
    expect(screen.getByText("Gateway token not configured")).toBeInTheDocument();
    storage.mockRestore();
  });
  it("does not resurrect owner settings from a pending save after authentication changes", async () => {
    const pending = deferred<unknown>();
    mocks.patch.mockReturnValue(pending.promise);
    const panel = renderPanel();
    await screen.findByLabelText("Gateway endpoint");
    fireEvent.change(screen.getByLabelText("Replacement gateway token"), { target: { value: "old-user-secret" } });
    fireEvent.click(save());
    mocks.get.mockResolvedValueOnce({ data: null, error: { status: 403, value: { error: "Forbidden" } } });
    panel.rerender(<DirectHermesBotSettings botId="bot-a" token="new-user-token" />);
    await screen.findByRole("alert");
    expect(screen.queryByLabelText("Gateway endpoint")).not.toBeInTheDocument();
    await act(async () => pending.resolve({ data: { ...settings, revision: "revision-2" }, error: null }));
    expect(screen.queryByLabelText("Gateway endpoint")).not.toBeInTheDocument();
    expect(screen.queryByText(/settings saved/)).not.toBeInTheDocument();
    panel.rerender(<DirectHermesBotSettings botId="bot-a" token={null} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/Sign in/);
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });
  it.each(["success", "conflict"])("isolates drafts and a delayed %s response when switching bots", async outcome => {
    const pending = deferred<unknown>();
    mocks.patch.mockReturnValue(pending.promise);
    const panel = renderPanel();
    await screen.findByLabelText("Gateway endpoint");
    fireEvent.change(screen.getByLabelText("Replacement gateway token"), { target: { value: "only-for-bot-a" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Alice" }));
    fireEvent.click(acknowledge());
    fireEvent.click(save());
    mocks.get.mockResolvedValueOnce({ data: { ...settings, botId: "bot-b", endpoint: "https://bot-b.example.com", revision: "bot-b-revision" }, error: null });
    panel.rerender(<DirectHermesBotSettings botId="bot-b" token="user-token" />);
    expect(await screen.findByLabelText("Gateway endpoint")).toHaveValue("https://bot-b.example.com");
    expect(screen.getByLabelText("Gateway endpoint")).toBeEnabled();
    expect(screen.getByLabelText("Replacement gateway token")).toHaveValue("");
    expect(screen.getByRole("checkbox", { name: "Alice" })).not.toBeChecked();
    expect(acknowledge()).not.toBeChecked();
    await act(async () => pending.resolve(outcome === "success"
      ? { data: { ...settings, allowedUserIds: ["human-a"], revision: "revision-2" }, error: null }
      : { data: null, error: { status: 409, value: { error: "stale bot A" } } }));
    expect(screen.getByLabelText("Gateway endpoint")).toHaveValue("https://bot-b.example.com");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(save()).toBeDisabled();
    panel.rerender(<DirectHermesBotSettings botId="bot-a" token="user-token" />);
    await screen.findByLabelText("Gateway endpoint");
    expect(screen.getByLabelText("Replacement gateway token")).toHaveValue("");
    expect(mocks.get).toHaveBeenCalledTimes(3);
  });
  it("never exposes save diagnostics or claims success on failure and allows reloading eligibility", async () => {
    mocks.patch.mockRejectedValue(new Error("gateway token=do-not-render"));
    renderPanel();
    await screen.findByLabelText("Gateway endpoint");
    fireEvent.change(screen.getByLabelText("Replacement gateway token"), { target: { value: "draft-secret" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Alice" }));
    fireEvent.click(acknowledge());
    fireEvent.click(save());
    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not save Direct Hermes settings/);
    expect(screen.queryByText(/do-not-render/)).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Replacement gateway token")).toHaveValue("");
    expect(acknowledge()).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Alice" })).toBeChecked();
    expect(save()).toBeDisabled();
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    mocks.get.mockResolvedValueOnce({ data: { ...settings, eligibleUsers: [] }, error: null });
    fireEvent.click(screen.getByRole("button", { name: "Reload settings (discard draft)" }));
    await screen.findByLabelText("Gateway endpoint");
    expect(screen.queryByRole("checkbox", { name: "Alice" })).not.toBeInTheDocument();
    expect(screen.getByText(/No eligible people/)).toBeInTheDocument();
  });
  it("blocks a stale save until an explicit reload discards the draft and uses the fresh revision", async () => {
    mocks.patch.mockResolvedValueOnce({ data: null, error: { status: 409, value: { error: "raw stale error token=secret" } } })
      .mockResolvedValueOnce({ data: { ...settings, allowedUserIds: ["human-b", "human-a"], revision: "revision-3" }, error: null });
    renderPanel();
    await screen.findByLabelText("Gateway endpoint");
    fireEvent.change(screen.getByLabelText("Replacement gateway token"), { target: { value: "draft-secret" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Alice" }));
    fireEvent.click(acknowledge());
    fireEvent.click(save());
    expect(await screen.findByRole("alert")).toHaveTextContent(/Settings changed elsewhere/);
    expect(screen.getByLabelText("Replacement gateway token")).toHaveValue("");
    expect(acknowledge()).not.toBeChecked();
    expect(save()).toBeDisabled();
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    mocks.get.mockResolvedValueOnce({ data: { ...settings, allowedUserIds: ["human-b"], revision: "revision-2" }, error: null });
    fireEvent.click(screen.getByRole("button", { name: "Reload settings (discard draft)" }));
    expect(await screen.findByRole("checkbox", { name: "Bob" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Alice" })).not.toBeChecked();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(save()).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Alice" }));
    fireEvent.click(acknowledge());
    fireEvent.click(save());
    await screen.findByText(/Direct Hermes settings saved/);
    expect(mocks.patch).toHaveBeenNthCalledWith(2, { revision: "revision-2", allowedUserIds: ["human-b", "human-a"], acknowledgeSharedAccess: true }, auth);
  });
  it("shows a safe load error and lets the owner retry without rendering a settings draft", async () => {
    mocks.get.mockResolvedValueOnce({ data: null, error: { status: 503, value: { error: "unsafe diagnostic token=secret" } } });
    renderPanel();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load Direct Hermes settings.");
    expect(screen.queryByText(/unsafe diagnostic/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Gateway endpoint")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry loading settings" }));
    expect(await screen.findByLabelText("Gateway endpoint")).toHaveValue(settings.endpoint);
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(save()).toBeDisabled();
  });
  it("requires a replacement token for an endpoint change and rejects unsafe or invalid endpoint URLs", async () => {
    const endpoint = "wss://other.example.com/api/ws";
    mocks.patch.mockResolvedValue({ data: { ...settings, endpoint, revision: "revision-2" }, error: null });
    renderPanel();
    const input = await screen.findByLabelText("Gateway endpoint");
    const token = screen.getByLabelText("Replacement gateway token");
    fireEvent.change(input, { target: { value: endpoint } });
    expect(save()).toBeDisabled();
    expect(screen.getByText("Changing the endpoint requires a replacement gateway token.")).toBeInTheDocument();
    fireEvent.change(token, { target: { value: "replacement-token" } });
    expect(save()).toBeEnabled();
    for (const invalid of ["", "not a url", "ftp://example.com", "wss://user:secret@example.com/api/ws", "https://example.com?token=secret", "wss://example.com#secret"]) {
      fireEvent.change(input, { target: { value: invalid } });
      expect(save()).toBeDisabled();
      fireEvent.submit(save().closest("form")!);
      expect(mocks.patch).not.toHaveBeenCalled();
    }
    fireEvent.change(input, { target: { value: endpoint } });
    fireEvent.click(save());
    await screen.findByText(/Direct Hermes settings saved/);
    expect(mocks.patch).toHaveBeenCalledWith({ revision: "revision-1", endpoint, gatewayToken: "replacement-token" }, auth);
    expect(token).toHaveValue("");
    expect(save()).toBeDisabled();
  });
  it("replaces the gateway token without sending unchanged settings and clears the secret after saving", async () => {
    mocks.patch.mockResolvedValue({ data: { ...settings, revision: "revision-2" }, error: null });
    renderPanel();
    const token = await screen.findByLabelText("Replacement gateway token");
    expect(token).toHaveValue("");
    expect(token).toHaveAttribute("autocomplete", "new-password");
    fireEvent.change(token, { target: { value: "  " } });
    expect(save()).toBeDisabled();
    fireEvent.change(token, { target: { value: "replacement-token" } });
    expect(save()).toBeEnabled();
    fireEvent.click(save());
    await screen.findByText(/Direct Hermes settings saved/);
    expect(mocks.patch).toHaveBeenCalledWith({ revision: "revision-1", gatewayToken: "replacement-token" }, auth);
    expect(token).toHaveValue("");
    expect(save()).toBeDisabled();
  });
  it("retains unavailable grants until explicitly removed by ID and allows revocation without sharing acknowledgement", async () => {
    mocks.get.mockResolvedValue({ data: { ...settings, allowedUserIds: ["human-a", "unavailable-id"] }, error: null });
    mocks.patch.mockResolvedValueOnce({ data: { ...settings, allowedUserIds: ["unavailable-id"], revision: "revision-2" }, error: null })
      .mockResolvedValueOnce({ data: { ...settings, revision: "revision-3" }, error: null });
    renderPanel();
    await screen.findByLabelText("Gateway endpoint");
    expect(screen.getByRole("checkbox", { name: "Unavailable user (unavailable-id)" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Alice" }));
    expect(acknowledge()).not.toBeChecked();
    expect(save()).toBeEnabled();
    fireEvent.click(save());
    await screen.findByText(/Direct Hermes settings saved/);
    expect(mocks.patch).toHaveBeenNthCalledWith(1, { revision: "revision-1", allowedUserIds: ["unavailable-id"] }, auth);
    fireEvent.click(screen.getByRole("checkbox", { name: "Unavailable user (unavailable-id)" }));
    fireEvent.click(save());
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(2));
    expect(mocks.patch).toHaveBeenNthCalledWith(2, { revision: "revision-2", allowedUserIds: [] }, auth);
    expect(await screen.findByText(/Only you \(the owner\)/)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Unavailable user (unavailable-id)" })).not.toBeInTheDocument();
  });
  it("defaults to owner-only and requires explicit shared-gateway acknowledgement before granting a human access", async () => {
    const pending = deferred<unknown>();
    mocks.patch.mockReturnValue(pending.promise);
    renderPanel();
    await screen.findByLabelText("Gateway endpoint");
    expect(screen.getByRole("heading", { name: "Who can talk to this bot" })).toBeInTheDocument();
    expect(screen.getByText(/Only you \(the owner\)/)).toBeInTheDocument();
    expect(screen.getByText(/same Hermes gateway.*all its sessions and runtime controls/i)).toBeInTheDocument();
    expect(screen.getByText(/not isolated private-chat access/i)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Alice" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Bob" })).not.toBeChecked();
    expect(acknowledge()).not.toBeChecked();
    expect(save()).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Alice" }));
    expect(save()).toBeDisabled();
    fireEvent.click(save());
    expect(mocks.patch).not.toHaveBeenCalled();
    fireEvent.click(acknowledge());
    expect(save()).toBeEnabled();
    fireEvent.click(save());
    expect(screen.getByRole("button", { name: "Saving Direct Hermes settings…" })).toBeDisabled();
    expect(screen.getByLabelText("Gateway endpoint")).toBeDisabled();
    expect(mocks.patch).toHaveBeenCalledWith({ revision: "revision-1", allowedUserIds: ["human-a"], acknowledgeSharedAccess: true }, auth);
    expect(mocks.bots).toHaveBeenCalledWith({ botId: "bot-a" });
    await act(async () => pending.resolve({ data: { ...settings, allowedUserIds: ["human-a"], revision: "revision-2" }, error: null }));
    expect(screen.getByRole("status")).toHaveTextContent(/saved.*reconnect/i);
    expect(screen.getByRole("checkbox", { name: "Alice" })).toBeChecked();
    expect(acknowledge()).not.toBeChecked();
    expect(save()).toBeDisabled();
  });
});
