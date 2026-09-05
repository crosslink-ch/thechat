import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectHermesChat } from "./direct-hermes-chat";
import { DirectHermesTestSocket, testConnection, deferred } from "./direct-hermes-test-transport";

const chats: DirectHermesChat[] = [];
afterEach(() => { chats.splice(0).forEach(chat => chat.dispose()); vi.restoreAllMocks(); });
async function setup() {
  const socket = new DirectHermesTestSocket();
  const chat = new DirectHermesChat(testConnection(socket)); chats.push(chat);
  await chat.connect(); await chat.newSession();
  return { chat, socket };
}
const catalog = {
  pairs: [["/branch", "Branch conversation"], ["/new", "New session"], ["/status", "Status"]],
  canon: { "/fork": "/branch", "/branch": "/branch", "/reset": "/new" },
  categories: [{ name: "Session", pairs: [["/branch", "Branch conversation"], ["/new", "New session"], ["/status", "Status"]] }],
};

describe("Direct Hermes slash controller through the real JSON-RPC client", () => {
  it.each(["/new", "/reset", "/clear"])("%s starts another session without destroying history", async command => {
    const { chat, socket } = await setup(); const parent = chat.getSnapshot().active!;
    parent.entries = [{ id: "old", role: "assistant", text: "Keep history" }];
    socket.handle = method => method === "session.create" ? { session_id: "runtime-new", stored_session_id: "stored-new", messages: [] } : method === "commands.catalog" ? catalog : { sessions: [] };
    chat.setDraft(command); await expect(chat.send()).resolves.toBe(true);
    expect(chat.getSnapshot().active).toMatchObject({ runtimeId: "runtime-new", storedId: "stored-new", phase: "idle" });
    expect(parent.entries[0].text).toBe("Keep history");
    expect(socket.calls.filter(call => call.method === "session.create")).toHaveLength(2);
    expect(socket.calls.some(call => /delete|clear|prompt.submit/.test(call.method))).toBe(false);
  });
  it("refuses slash commands mixed with attachments before any RPC", async () => {
    const { chat, socket } = await setup();
    await chat.addAttachments([new File(["x"], "x.txt")]); chat.setDraft("/branch child");
    const before = socket.calls.length;
    expect(chat.canSend()).toBe(false); await expect(chat.send()).resolves.toBe(false);
    expect(socket.calls).toHaveLength(before);
    expect(chat.getSnapshot().active).toMatchObject({ draft: "/branch child", attachments: [expect.objectContaining({ status: "queued" })] });
    expect(chat.getSnapshot().active!.error).toMatch(/attachments.*slash|slash.*attachments/i);
  });
  it("does not navigate to a late branch after selection changes and never adopts one after disposal", async () => {
    const { chat, socket } = await setup();
    const branch = deferred<unknown>();
    socket.handle = method => method === "session.branch" ? branch.promise : method === "session.resume" ? { session_id: "runtime-b", stored_session_id: "saved-b", messages: [] } : catalog;
    chat.setDraft("/branch child"); const sent = chat.send();
    await chat.selectSession("saved-b"); chat.setDraft("B");
    branch.resolve({ session_id: "runtime-child", stored_session_id: "stored-child", messages: [] }); await sent;
    expect(chat.getSnapshot().active).toMatchObject({ storedId: "saved-b", draft: "B" });
    await chat.selectSession("stored-1"); chat.setDraft("/branch discarded");
    const abandoned = deferred<unknown>(); socket.handle = () => abandoned.promise;
    const pending = chat.send(); chat.dispose(); abandoned.resolve({ session_id: "discarded", stored_session_id: "discarded", messages: [] }); await pending;
    expect(chat.getSnapshot().opened.some(row => row.runtimeId === "discarded")).toBe(false);
  });
  it.each([
    ["/title A new title", "session.title", { title: "A new title" }, { title: "A new title" }],
    ["/status", "session.status", {}, { output: "Session healthy" }],
    ["/model", "slash.exec", { command: "model" }, { output: "Current model: test" }],
    ["/model provider/model --provider test", "config.set", { key: "model", value: "provider/model --provider test" }, { model: "provider/model" }],
    ["/usage", "slash.exec", { command: "usage" }, { output: "Usage report" }],
  ])("routes %s through its real gateway contract, displaying results instead of submitting raw slash text", async (command, method, params, result) => {
    const { chat, socket } = await setup();
    socket.handle = (called, passed) => {
      if (called === "commands.catalog") return catalog;
      expect(called).toBe(method); expect(passed).toEqual({ session_id: "runtime-1", ...params }); return result;
    };
    chat.setDraft(command as string); await expect(chat.send()).resolves.toBe(true);
    expect(socket.calls.some(call => call.method === "prompt.submit" || call.method === "command.dispatch")).toBe(false);
    expect(chat.getSnapshot().active).toMatchObject({ draft: "", phase: "idle" });
    expect(chat.getSnapshot().active!.entries.at(-1)).toMatchObject({ role: "system", text: expect.stringContaining(String(Object.values(result)[0])) });
    if (method === "session.title") expect(chat.getSnapshot().active!.title).toBe("A new title");
  });
  it("allows /stop during a running turn and waits for terminal confirmation", async () => {
    const { chat, socket } = await setup(); chat.setDraft("Run"); await chat.send();
    socket.handle = (method, params) => { expect(method).toBe("session.interrupt"); expect(params).toEqual({ session_id: "runtime-1" }); return { status: "interrupted" }; };
    chat.setDraft("/stop"); expect(chat.canSend()).toBe(true); await expect(chat.send()).resolves.toBe(true);
    expect(chat.getSnapshot().active).toMatchObject({ phase: "stopping", draft: "" });
  });
  it("renders catalog help with an honest unsupported-surface note", async () => {
    const { chat, socket } = await setup(); socket.handle = () => catalog;
    chat.setDraft("/help"); await expect(chat.send()).resolves.toBe(true);
    expect(chat.getSnapshot().active!.entries.at(-1)?.text).toMatch(/\/branch[\s\S]*unsupported|unsupported[\s\S]*\/branch/i);
    expect(socket.calls.some(call => call.method === "prompt.submit")).toBe(false);
  });
  it("uses catalog aliases and command.resolve for supported gateway commands; unknown/local commands remain editable", async () => {
    const { chat, socket } = await setup();
    socket.handle = (method, params) => {
      if (method === "commands.catalog") return { ...catalog, canon: { ...catalog.canon, "/stats": "/status" } };
      if (method === "command.resolve") return { canonical: params.name === "about" ? "version" : "skin", category: "Display" };
      if (method === "session.status") return { output: "Healthy" };
      expect(method).toBe("slash.exec"); expect(params.command).toBe("version"); return { output: "Hermes version" };
    };
    chat.setDraft("/stats"); await expect(chat.send()).resolves.toBe(true);
    chat.setDraft("/about"); await expect(chat.send()).resolves.toBe(true);
    chat.setDraft("/skin dark"); await expect(chat.send()).resolves.toBe(false);
    expect(chat.getSnapshot().active).toMatchObject({ phase: "idle", draft: "/skin dark", error: expect.stringMatching(/unsupported|not supported/i) });
    socket.handle = method => { expect(method).toBe("command.resolve"); throw new Error("unknown command: nonexistent"); };
    chat.setDraft("/nonexistent"); await expect(chat.send()).resolves.toBe(false);
    expect(chat.getSnapshot().active).toMatchObject({ phase: "idle", draft: "/nonexistent" });
    expect(socket.calls.some(call => call.method === "prompt.submit")).toBe(false);
  });
  it.each(["exec", "plugin", "skill", "send", "alias"])("honors a catalog-discovered %s dispatch and keeps its arguments/session", async type => {
    const { chat, socket } = await setup();
    socket.handle = (method, params) => {
      if (method === "commands.catalog") return { pairs: [["/custom", "Custom command"]], canon: { "/custom": "/custom" }, categories: [{ name: "User commands", pairs: [["/custom", "Custom command"]] }] };
      if (method === "command.dispatch") { expect(params).toEqual({ session_id: "runtime-1", name: "custom", arg: "some  args" }); return { type, output: "Command output", message: "Expanded task", display: "/custom some  args", target: "title Prefix" }; }
      if (type === "alias") { expect(method).toBe("session.title"); expect(params.title).toBe("Prefix some  args"); return { title: "Prefix some  args" }; }
      expect(method).toBe("prompt.submit"); expect(params.text).toBe("Expanded task"); expect(params.session_id).toBe("runtime-1"); return { status: "streaming" };
    };
    chat.setDraft("/custom some  args"); await expect(chat.send()).resolves.toBe(true);
    expect(chat.getSnapshot().active!.draft).toBe("");
    if (["exec", "plugin"].includes(type)) expect(chat.getSnapshot().active!.entries.at(-1)?.text).toContain("Command output");
    if (["skill", "send"].includes(type)) expect(chat.getSnapshot().active!.entries.at(-1)?.text).toBe("/custom some  args");
    expect(socket.calls.some(call => call.method === "slash.exec")).toBe(false);
  });
  it.each(["approvals manual", "agents", "background Explain", "debug", "goal status", "loop list", "personality concise", "queue Next", "retry", "rollback 2", "save md report.md", "steer Change direction", "tools", "undo 1", "compress --preview"])("routes supported backend /%s without a command.dispatch fallback", async command => {
    const { chat, socket } = await setup();
    socket.handle = (method, params) => { expect(method).toBe("slash.exec"); expect(params).toEqual({ session_id: "runtime-1", command }); return { output: "Backend result" }; };
    chat.setDraft(`/${command}`); await expect(chat.send()).resolves.toBe(true);
    expect(chat.getSnapshot().active!.entries.at(-1)?.text).toContain("Backend result");
  });
  it.each(["session.branch", "slash.exec", "command.dispatch"])("keeps %s timeouts uncertain across explicit Sync and never falls back or replays", async method => {
    const { chat, socket } = await setup();
    socket.handle = called => called === "commands.catalog" ? { pairs: [["/custom", "Custom"]], skills: { "/custom": {} } } : new Promise(() => {});
    chat.setDraft(method === "session.branch" ? "/branch Maybe" : method === "slash.exec" ? "/usage" : "/custom");
    vi.useFakeTimers();
    try {
      const sent = chat.send(); await vi.advanceTimersByTimeAsync(120_001); await sent;
      expect(chat.getSnapshot().active!.phase).toBe("uncertain");
      socket.handle = () => ({ session_id: "runtime-1", stored_session_id: "stored-1", messages: [], running: false });
      await chat.syncSession(); socket.event("message.complete", { text: "Old event" });
      expect(chat.canSend()).toBe(false); await chat.send();
      expect(socket.calls.filter(call => call.method === method)).toHaveLength(1);
      expect(chat.getSnapshot().active!.draft).not.toBe("");
    } finally { vi.useRealTimers(); }
  });
  it("bounds alias recursion and never sends unsupported/malformed dispatches as prompts", async () => {
    const { chat, socket } = await setup();
    socket.handle = method => method === "commands.catalog" ? { pairs: [["/cycle", "Cycle"]], skills: { "/cycle": {} } } : { type: "alias", target: "cycle" };
    chat.setDraft("/cycle");
    // A hard boundary in the fake ensures a buggy infinite recursion fails fast.
    const handle = socket.handle;
    socket.handle = (method, params) => { if (socket.calls.filter(call => call.method === "command.dispatch").length > 10) throw new Error("unbounded recursion"); return handle(method, params); };
    await expect(chat.send()).resolves.toBe(false);
    expect(socket.calls.filter(call => call.method === "command.dispatch").length).toBeLessThanOrEqual(8);
    expect(chat.getSnapshot().active!.error).toMatch(/alias.*(loop|cycle|limit)|recurs/i);
    expect(socket.calls.some(call => call.method === "prompt.submit")).toBe(false);
  });
  it("keeps /undo prefill editable instead of silently discarding or executing it", async () => {
    const { chat, socket } = await setup(); socket.handle = () => ({ type: "prefill", message: "Edit this restored prompt", notice: "Restored last turn" });
    chat.setDraft("/undo"); await expect(chat.send()).resolves.toBe(true);
    expect(chat.getSnapshot().active!.draft).toBe("Edit this restored prompt");
    expect(chat.getSnapshot().active!.entries.at(-1)?.text).toContain("Restored last turn");
    expect(socket.calls.some(call => call.method === "prompt.submit")).toBe(false);
  });
  it("preserves a rejected/malformed dispatch and never interprets its raw slash as a prompt", async () => {
    const { chat, socket } = await setup(); socket.handle = method => method === "commands.catalog" ? { pairs: [["/custom", "Custom"]], skills: { "/custom": {} } } : { type: "unrecognized", message: "/branch should not run" };
    chat.setDraft("/custom"); await expect(chat.send()).resolves.toBe(false);
    expect(chat.getSnapshot().active!.draft).toBe("/custom");
    expect(chat.getSnapshot().active!.error).toMatch(/unsupported|invalid/i);
    expect(socket.calls.some(call => call.method === "prompt.submit" || call.method === "session.branch")).toBe(false);
  });
  it("pins a delayed skill expansion to its original session and preserves an unknown expanded-prompt outcome", async () => {
    const { chat, socket } = await setup(); const dispatch = deferred<unknown>();
    socket.handle = method => method === "commands.catalog" ? { pairs: [["/custom", "Custom"]], skills: { "/custom": {} } } : method === "command.dispatch" ? dispatch.promise : method === "session.resume" ? { session_id: "runtime-b", stored_session_id: "saved-b", messages: [] } : { malformed: true };
    chat.setDraft("/custom task"); const sent = chat.send();
    await vi.waitFor(() => expect(socket.calls.some(call => call.method === "command.dispatch")).toBe(true));
    await chat.selectSession("saved-b"); chat.setDraft("Keep B");
    dispatch.resolve({ type: "skill", message: "Expanded task" }); await sent;
    expect(socket.calls.find(call => call.method === "prompt.submit")?.params).toEqual({ session_id: "runtime-1", text: "Expanded task", queued: true });
    expect(chat.getSnapshot().active).toMatchObject({ storedId: "saved-b", draft: "Keep B", entries: [] });
    await chat.selectSession("stored-1");
    socket.handle = () => ({ session_id: "runtime-1", stored_session_id: "stored-1", messages: [], running: false });
    await chat.syncSession(); expect(chat.canSend()).toBe(false);
    expect(chat.getSnapshot().active!.draft).toBe("/custom task");
  });
  it.each(["/new Named", "/reset Named", "/clear Named", "/status ignored"])("rejects unsupported arguments to %s rather than silently dropping their semantics", async command => {
    const { chat, socket } = await setup(); const before = socket.calls.length;
    chat.setDraft(command); await expect(chat.send()).resolves.toBe(false);
    expect(socket.calls).toHaveLength(before);
    expect(chat.getSnapshot().active).toMatchObject({ draft: command, phase: "idle", error: expect.stringMatching(/argument/i) });
  });
  it.each(["/branch", "/fork"])("%s calls session.branch and adopts the child without changing parent history/runtime", async command => {
    const { chat, socket } = await setup(); chat.setDraft("Parent prompt"); await chat.send();
    socket.event("message.complete", { text: "Parent answer" });
    const parent = chat.getSnapshot().active!;
    const history = structuredClone(parent.entries);
    socket.handle = (method, params) => {
      if (method === "commands.catalog") return catalog;
      if (method === "session.list") return { sessions: [{ id: "stored-child", title: "Alternative" }] };
      expect(method).toBe("session.branch"); expect(params).toEqual({ session_id: "runtime-1", name: "Alternative" });
      return { session_id: "runtime-child", stored_session_id: "stored-child", title: "Alternative", parent: "stored-1", messages: [{ role: "user", text: "Parent prompt" }, { role: "assistant", text: "Parent answer" }], info: { title: "Alternative" } };
    };
    chat.setDraft(`${command} Alternative`);
    await expect(chat.send()).resolves.toBe(true);
    expect(chat.getSnapshot().active).toMatchObject({ key: "stored-child", runtimeId: "runtime-child", storedId: "stored-child", title: "Alternative", draft: "", phase: "idle" });
    expect(chat.getSnapshot().active!.entries.map(row => row.text)).toEqual(["Parent prompt", "Parent answer"]);
    expect(parent).toMatchObject({ runtimeId: "runtime-1", storedId: "stored-1", entries: history, draft: "", phase: "idle" });
    expect(socket.calls.filter(call => call.method === "prompt.submit")).toHaveLength(1);
    expect(chat.getSnapshot().sessions[0].id).toBe("stored-child");
    expect(chat.getSnapshot().commands).toContainEqual({ name: "/branch", description: "Branch conversation" });
  });
});
