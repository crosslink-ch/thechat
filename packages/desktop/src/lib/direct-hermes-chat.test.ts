import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectHermesChat } from "./direct-hermes-chat";
import { DirectHermesTestSocket, testConnection, deferred } from "./direct-hermes-test-transport";

const chats: DirectHermesChat[] = [];
afterEach(() => { chats.splice(0).forEach(chat => chat.dispose()); vi.restoreAllMocks(); });
async function setup() {
  const socket = new DirectHermesTestSocket();
  const chat = new DirectHermesChat(testConnection(socket));
  chats.push(chat);
  await chat.connect();
  return { chat, socket };
}

describe("Direct Hermes chat through the real JSON-RPC client", () => {
  it("stages local files without reading/uploading until Send, and uses the gateway's escaped ref", async () => {
    const { chat, socket } = await setup(); await chat.newSession();
    const file = new File(["report"], 'report [final] "x".pdf', { type: "application/pdf" });
    const before = socket.calls.length;
    await expect(chat.addAttachments([file])).resolves.toBe(true);
    expect(socket.calls).toHaveLength(before);
    const attachment = chat.getSnapshot().active!.attachments![0];
    expect(attachment).toMatchObject({ name: file.name, size: 6, type: "file", status: "queued" });
    expect(chat.canSend()).toBe(true);
    await chat.removeAttachment(attachment.id);
    expect(socket.calls).toHaveLength(before);
    expect(chat.canSend()).toBe(false);
    await chat.addAttachments([file]);
    socket.handle = (method, params) => {
      if (method === "file.attach") {
        expect(params).toEqual({ session_id: "runtime-1", name: file.name, data_url: "data:application/pdf;base64,cmVwb3J0" });
        return { attached: true, name: file.name, path: '/gateway/report [final] "x".pdf', ref_text: '@file:`/gateway/report [final] "x".pdf`', uploaded: true };
      }
      expect(method).toBe("prompt.submit");
      expect(params.text).toContain('@file:`/gateway/report [final] "x".pdf`');
      expect(params.text).toContain("attached files");
      return { status: "streaming" };
    };
    await expect(chat.send()).resolves.toBe(true);
    expect(chat.getSnapshot().active!.attachments).toEqual([]);
    expect(chat.getSnapshot().active!.entries[0].attachments).toEqual([expect.objectContaining({ name: file.name, size: 6 })]);
  });
  it("rejects an entire invalid attachment batch before reading bytes (2 MiB/file, five/session, zero-byte allowed)", async () => {
    const { chat, socket } = await setup(); await chat.newSession();
    const read = vi.spyOn(FileReader.prototype, "readAsDataURL");
    const before = socket.calls.length;
    const large = new File([new Uint8Array(2 * 1024 * 1024 + 1)], "too-large.bin");
    await expect(chat.addAttachments([large])).resolves.toBe(false);
    expect(chat.getSnapshot().active!.error).toContain("2 MiB");
    expect(chat.getSnapshot().active!.attachments ?? []).toEqual([]);
    const empty = new File([], "empty.txt");
    await expect(chat.addAttachments(Array.from({ length: 6 }, () => empty))).resolves.toBe(false);
    expect(chat.getSnapshot().active!.error).toContain("5");
    await expect(chat.addAttachments([new File([new Uint8Array(2 * 1024 * 1024)], "limit.bin"), empty])).resolves.toBe(true);
    expect(chat.getSnapshot().active!.attachments).toHaveLength(2);
    expect(read).not.toHaveBeenCalled(); expect(socket.calls).toHaveLength(before);
    read.mockRestore();
  });
  it("uploads images as files, queues only known gateway paths, and detaches after rejected prompts", async () => {
    const { chat, socket } = await setup(); await chat.newSession();
    const path = '/gateway/attachments/photo [1] "two".png';
    await chat.addAttachments([new File(["png"], 'photo [1] "two".png', { type: "image/png" })]);
    chat.setDraft("Describe");
    socket.handle = (method, params) => {
      if (method === "file.attach") return { attached: true, path, ref_text: "@file:ignored-image-reference" };
      if (method === "image.attach") { expect(params).toEqual({ session_id: "runtime-1", path }); return { attached: true, path }; }
      if (method === "image.detach") { expect(params).toEqual({ session_id: "runtime-1", path }); return { detached: false, count: 0 }; }
      expect(method).toBe("prompt.submit"); expect(params.text).toBe("Describe");
      throw new Error("Provider unavailable");
    };
    await expect(chat.send()).resolves.toBe(false);
    expect(socket.calls.slice(-4).map(call => call.method)).toEqual(["file.attach", "image.attach", "prompt.submit", "image.detach"]);
    expect(chat.getSnapshot().active).toMatchObject({ draft: "Describe", phase: "idle", entries: [], attachments: [expect.objectContaining({ type: "image", status: "ready" })] });
    socket.handle = method => method === "image.attach" ? { attached: true, path } : { status: "streaming" };
    await expect(chat.send()).resolves.toBe(true);
    expect(socket.calls.filter(call => call.method === "file.attach")).toHaveLength(1);
  });
  it("fails closed when pending-image cleanup is unconfirmed, and explicit Sync retries only cleanup", async () => {
    const { chat, socket } = await setup(); await chat.newSession();
    await chat.addAttachments([new File(["png"], "photo.png", { type: "image/png" })]); chat.setDraft("Describe");
    socket.handle = method => {
      if (method === "file.attach") return { attached: true, path: "/gateway/photo.png", ref_text: "@file:/gateway/photo.png" };
      if (method === "image.attach") return { attached: true, path: "/gateway/photo.png" };
      throw new Error("Unavailable");
    };
    await chat.send();
    expect(chat.getSnapshot().active).toMatchObject({ phase: "uncertain", attachments: [expect.objectContaining({ status: "uncertain" })] });
    expect(chat.canSend()).toBe(false);
    socket.handle = method => method === "session.activate"
      ? { session_id: "runtime-1", stored_session_id: "stored-1", running: false, messages: [] }
      : { detached: false, count: 0 };
    await expect(chat.syncSession()).resolves.toBe(true);
    expect(socket.calls.at(-1)?.method).toBe("image.detach");
    expect(chat.getSnapshot().active).toMatchObject({ phase: "idle", draft: "Describe", attachments: [expect.objectContaining({ status: "ready" })] });
    expect(socket.calls.filter(call => call.method === "prompt.submit")).toHaveLength(1);
  });
  it.each(["image.attach", "prompt.submit"])("never replays an ambiguous %s, even after an idle Sync or a late completion event", async blocked => {
    const { chat, socket } = await setup(); await chat.newSession();
    await chat.addAttachments([new File(["png"], "photo.png")]); chat.setDraft("Describe");
    vi.useFakeTimers();
    try {
      socket.handle = method => {
        if (method === blocked) return new Promise(() => {});
        if (method === "file.attach") return { attached: true, path: "/gateway/photo.png", ref_text: "@file:/gateway/photo.png" };
        return { attached: true, path: "/gateway/photo.png" };
      };
      const sent = chat.send();
      await vi.waitFor(() => expect(socket.calls.some(call => call.method === blocked)).toBe(true));
      await vi.advanceTimersByTimeAsync(120_001); await sent;
      expect(chat.getSnapshot().active).toMatchObject({ phase: "uncertain", draft: "Describe", attachments: [expect.objectContaining({ status: "uncertain" })] });
      socket.handle = () => ({ session_id: "runtime-1", stored_session_id: "stored-1", messages: [], running: false });
      await chat.syncSession();
      socket.event("message.complete", { text: "Late unrelated event" });
      expect(chat.canSend()).toBe(false); await chat.send();
      expect(socket.calls.filter(call => call.method === blocked)).toHaveLength(1);
      expect(chat.getSnapshot().active!.error).toMatch(/unknown|unconfirmed/i);
    } finally { vi.useRealTimers(); }
  });
  it("keeps failed file reads retryable without uploading and aborts a late reader after disposal", async () => {
    const { chat, socket } = await setup(); await chat.newSession();
    await chat.addAttachments([new File(["a"], "a.txt")]); chat.setDraft("Keep");
    const before = socket.calls.length;
    const read = vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function(this: FileReader) { this.dispatchEvent(new Event("error")); });
    await chat.send();
    expect(chat.getSnapshot().active).toMatchObject({ phase: "idle", draft: "Keep", entries: [], attachments: [expect.objectContaining({ status: "error" })] });
    expect(socket.calls).toHaveLength(before);
    let reader!: FileReader;
    read.mockImplementation(function(this: FileReader) { reader = this; });
    const sent = chat.send(); chat.dispose();
    Object.defineProperty(reader, "result", { value: "data:text/plain;base64,YQ==" }); reader.dispatchEvent(new Event("load"));
    await sent; expect(socket.calls).toHaveLength(before);
    read.mockRestore();
  });
  it("pins uploads and late ACKs to the sending session, clearing only captured attachment IDs", async () => {
    const { chat, socket } = await setup(); await chat.newSession();
    await chat.addAttachments([new File([], "empty.txt")]); chat.setDraft("Send A");
    const ack = deferred<unknown>();
    socket.handle = (method, params) => {
      if (method === "file.attach") { expect(params.data_url).toMatch(/;base64,$/); return { attached: true, path: "/gateway/empty.txt", ref_text: "@file:/gateway/empty.txt" }; }
      if (method === "prompt.submit") { expect(params.session_id).toBe("runtime-1"); return ack.promise; }
      return { session_id: "runtime-b", stored_session_id: "saved-b", messages: [], running: false };
    };
    const sent = chat.send(); await chat.send();
    await chat.addAttachments([new File(["b"], "next.txt")]); chat.setDraft("Next A");
    await chat.selectSession("saved-b"); await chat.addAttachments([new File(["c"], "b.txt")]); chat.setDraft("B draft");
    ack.resolve({ status: "streaming" }); await sent;
    expect(chat.getSnapshot().active).toMatchObject({ storedId: "saved-b", draft: "B draft", attachments: [expect.objectContaining({ name: "b.txt", status: "queued" })] });
    await chat.selectSession("stored-1");
    expect(chat.getSnapshot().active).toMatchObject({ draft: "Next A", attachments: [expect.objectContaining({ name: "next.txt", status: "queued" })] });
    expect(socket.calls.filter(call => call.method === "file.attach")).toHaveLength(1);
  });
  it.each(["file.attach", "image.attach"])("Stop during %s waits for its ACK, cleans known images, and never submits a late prompt", async blocked => {
    const { chat, socket } = await setup(); await chat.newSession();
    await chat.addAttachments([new File(["png"], "photo.png")]); chat.setDraft("Keep cancelled draft");
    const ack = deferred<unknown>();
    socket.handle = (method, params) => {
      if (method === blocked) return ack.promise;
      if (method === "file.attach") return { attached: true, path: "/gateway/photo.png", ref_text: "@file:/gateway/photo.png" };
      if (method === "image.detach") { expect(params.path).toBe("/gateway/photo.png"); return { detached: true, count: 0 }; }
      return { status: "interrupted" };
    };
    const sent = chat.send(); await vi.waitFor(() => expect(socket.calls.some(call => call.method === blocked)).toBe(true));
    await expect(chat.stop()).resolves.toBe(true);
    ack.resolve({ attached: true, path: "/gateway/photo.png", ref_text: "@file:/gateway/photo.png" });
    await expect(sent).resolves.toBe(false);
    expect(socket.calls.some(call => call.method === "prompt.submit")).toBe(false);
    if (blocked === "image.attach") expect(socket.calls.some(call => call.method === "image.detach")).toBe(true);
    expect(chat.getSnapshot().active).toMatchObject({ draft: "Keep cancelled draft", phase: "idle", entries: [], attachments: [expect.objectContaining({ status: "ready" })] });
  });
  it("does not reuse a staged file after reconnect even when the runtime ID is unchanged", async () => {
    const { chat, socket } = await setup(); await chat.newSession();
    await chat.addAttachments([new File(["a"], "a.txt")]); chat.setDraft("Read");
    socket.handle = method => { if (method === "file.attach") return { attached: true, path: "/old/a.txt", ref_text: "@file:/old/a.txt" }; throw new Error("Rejected prompt"); };
    await chat.send(); socket.close();
    socket.handle = method => {
      if (method === "session.list") return { sessions: [] };
      if (method === "session.active_list") return { sessions: [{ id: "runtime-1", session_key: "stored-1" }] };
      if (method === "session.activate") return { session_id: "runtime-1", session_key: "stored-1", messages: [], running: false };
      if (method === "file.attach") return { attached: true, path: "/new/a.txt", ref_text: "@file:/new/a.txt" };
      return { status: "streaming" };
    };
    await chat.connect(); await expect(chat.send()).resolves.toBe(true);
    expect(socket.calls.filter(call => call.method === "file.attach")).toHaveLength(2);
    expect(socket.calls.at(-1)?.params.text).toContain("@file:/new/a.txt");
  });
  it("never drops a pending-image cleanup obligation when removal or a new gateway cannot confirm cleanup", async () => {
    const { chat, socket } = await setup(); await chat.newSession();
    await chat.addAttachments([new File(["a"], "a.png")]); chat.setDraft("Read");
    socket.handle = method => {
      if (method === "file.attach") return { attached: true, path: "/gateway/a.png", ref_text: "@file:/gateway/a.png" };
      if (method === "image.attach") return { attached: true, path: "/gateway/a.png" };
      throw new Error("Unavailable");
    };
    await chat.send(); const attachment = chat.getSnapshot().active!.attachments![0];
    await expect(chat.removeAttachment(attachment.id)).resolves.toBe(false);
    expect(chat.getSnapshot().active!.attachments).toContain(attachment);
    socket.close(); socket.handle = method => method === "session.list" ? { sessions: [] } : method === "session.active_list" ? { sessions: [] } : { session_id: "new-runtime", stored_session_id: "stored-1", messages: [], running: false };
    await chat.connect();
    expect(chat.canSend()).toBe(false);
    expect(chat.getSnapshot().active!.attachments).toContain(attachment);
    expect(chat.getSnapshot().active!.error).toMatch(/cleanup.*(binding|gateway|unconfirmed)/i);
  });
  it("Sync confirms only a newly observed submitted attachment prompt and clears only its captured draft/files", async () => {
    const { chat, socket } = await setup(); await chat.newSession();
    await chat.addAttachments([new File(["png"], "photo.png")]); chat.setDraft("Same text");
    chat.getSnapshot().active!.entries.push({ id: "old", role: "user", text: "Same text" });
    socket.handle = method => method === "file.attach" ? { attached: true, path: "/gateway/photo.png", ref_text: "@file:/gateway/photo.png" } : method === "image.attach" ? { attached: true, path: "/gateway/photo.png" } : { invalid: "unknown prompt ACK" };
    await chat.send();
    const sent = chat.getSnapshot().active!.attachments![0];
    socket.handle = () => ({ session_id: "runtime-1", stored_session_id: "stored-1", messages: [{ role: "user", text: "Same text" }], running: false });
    await chat.syncSession();
    expect(chat.getSnapshot().active).toMatchObject({ draft: "Same text", phase: "uncertain" });
    await chat.addAttachments([new File(["next"], "next.txt")]); chat.setDraft("New draft");
    socket.handle = () => ({ session_id: "runtime-1", stored_session_id: "stored-1", messages: [{ role: "user", text: "Same text" }, { role: "user", text: "Same text" }, { role: "assistant", text: "Confirmed answer" }], running: false });
    await chat.syncSession();
    expect(chat.getSnapshot().active).toMatchObject({ draft: "New draft", phase: "idle", attachments: [expect.objectContaining({ name: "next.txt" })] });
    expect(chat.getSnapshot().active!.attachments).not.toContain(sent);
    expect(socket.calls.filter(call => call.method === "prompt.submit")).toHaveLength(1);
  });
  it("removes a queued file synchronously so an immediate Send cannot capture it", async () => {
    const { chat, socket } = await setup(); await chat.newSession();
    await chat.addAttachments([new File(["a"], "a.txt")]); chat.setDraft("Text only");
    const removed = chat.removeAttachment(chat.getSnapshot().active!.attachments![0].id);
    await Promise.all([removed, chat.send()]);
    expect(socket.calls.some(call => call.method === "file.attach")).toBe(false);
  });
  it.each(["missing", "reclaimed"])("recovers a %s runtime through explicit Sync without replaying a prompt", async binding => {
    const { chat, socket } = await setup();
    if (binding === "missing") {
      socket.handle = () => { throw new Error("Resume temporarily unavailable"); };
      await chat.selectSession("saved-a");
    } else {
      await chat.newSession();
    }
    chat.setDraft("Keep my unsent draft");
    const storedId = chat.getSnapshot().active!.storedId;
    socket.handle = (method, params) => {
      if (method === "session.activate") {
        socket.frame({ jsonrpc: "2.0", id: socket.calls.at(-1)!.id, error: { code: 4001, message: "Session not found" } });
        return new Promise(() => {});
      }
      expect(method).toBe("session.resume");
      expect(params.session_id).toBe(storedId);
      return { session_id: "recovered-runtime", session_key: storedId, running: false, messages: [{ role: "assistant", text: "Saved response" }] };
    };
    await expect(chat.syncSession()).resolves.toBe(true);
    expect(chat.getSnapshot().active).toMatchObject({ runtimeId: "recovered-runtime", phase: "idle", draft: "Keep my unsent draft" });
    expect(chat.getSnapshot().active!.entries[0].text).toBe("Saved response");
    expect(socket.calls.some(call => call.method === "prompt.submit")).toBe(false);
  });
  it("keeps send locked until the ACK settles even when a terminal event arrives first", async () => {
    const { chat, socket } = await setup(); await chat.newSession();
    const ack = deferred<unknown>(); socket.handle = () => ack.promise;
    chat.setDraft("Only once"); const sent = chat.send();
    socket.event("message.complete", { text: "Fast final" });
    const duplicate = chat.send();
    ack.resolve({ status: "streaming" }); await Promise.all([sent, duplicate]);
    expect(socket.calls.filter(call => call.method === "prompt.submit")).toHaveLength(1);
  });
  it("does not clear a draft on a malformed prompt ACK", async () => {
    const { chat, socket } = await setup(); await chat.newSession();
    socket.handle = () => ({ unexpected: true }); chat.setDraft("Keep this"); await chat.send();
    expect(chat.getSnapshot().active).toMatchObject({ phase: "uncertain", draft: "Keep this" });
  });
  it("rejects a missing runtime binding instead of sending a durable ID to a live-only method", async () => {
    const { chat, socket } = await setup(); socket.handle = () => ({ messages: [] });
    await chat.selectSession("saved-a");
    expect(chat.getSnapshot().active!.phase).toBe("uncertain");
    expect(chat.getSnapshot().active!.error).toContain("runtime");
  });
  it("does not steal selection when a new-session request finishes after navigation", async () => {
    const { chat, socket } = await setup();
    const created = deferred<unknown>();
    socket.handle = method => method === "session.create" ? created.promise : { session_id: "runtime-a", session_key: "saved-a", messages: [], running: false };
    const creation = chat.newSession();
    await chat.selectSession("saved-a"); chat.setDraft("Keep selected draft");
    created.resolve({ session_id: "runtime-new", stored_session_id: "stored-new", messages: [] }); await creation;
    expect(chat.getSnapshot().active).toMatchObject({ storedId: "saved-a", draft: "Keep selected draft" });
  });
  it("preserves live events that arrive before resume returns its runtime ID", async () => {
    const { chat, socket } = await setup();
    const resumed = deferred<unknown>(); socket.handle = () => resumed.promise;
    const loading = chat.selectSession("saved-a");
    socket.event("message.delta", { text: "Fresh" }, "runtime-a");
    socket.event("message.complete", { text: "Fresh final" }, "runtime-a");
    resumed.resolve({ session_id: "runtime-a", session_key: "saved-a", running: true, messages: [{ role: "user", text: "Earlier question" }] }); await loading;
    expect(chat.getSnapshot().active!.entries.map(entry => entry.text)).toEqual(["Earlier question", "Fresh final"]);
    expect(chat.getSnapshot().active!.phase).toBe("idle");
  });
  it("leaves timed-out sends uncertain without losing the draft or submitting another copy", async () => {
    const { chat, socket } = await setup(); await chat.newSession();
    vi.useFakeTimers();
    try {
      socket.handle = () => new Promise(() => {}); chat.setDraft("Unconfirmed");
      const sent = chat.send(); await vi.advanceTimersByTimeAsync(120_001); await sent;
      expect(chat.getSnapshot().active).toMatchObject({ phase: "uncertain", draft: "Unconfirmed" });
      await chat.send();
      expect(socket.calls.filter(call => call.method === "prompt.submit")).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
  it("adopts canonical durable metadata, refreshes saved sessions, and restores blocked prompts from snapshots", async () => {
    const { chat, socket } = await setup(); await chat.newSession();
    socket.event("session.info", { stored_session_id: "compressed-tip", title: "Renamed session" });
    expect(chat.getSnapshot().active).toMatchObject({ storedId: "compressed-tip", title: "Renamed session" });
    socket.handle = method => method === "session.list" ? { sessions: [{ id: "compressed-tip", title: "Renamed session" }] } : {
      session_id: "runtime-1", session_key: "compressed-tip", running: true, messages: [],
      pending_approval: { request_id: "a2", command: "pwd" },
      pending_clarify: { request_id: "q2", question: "Where?" },
    };
    socket.event("sessions.changed", {}, "");
    await vi.waitFor(() => expect(chat.getSnapshot().sessions.map(row => row.id)).toEqual(["compressed-tip"]));
    await chat.syncSession();
    expect(chat.getSnapshot().active!.interactions.map(item => item.requestId)).toEqual(["a2", "q2"]);
    expect(chat.getSnapshot().active!.phase).toBe("running");
  });
  it("single-flights concurrent connection attempts and ignores a disposed pending ticket", async () => {
    const socket = new DirectHermesTestSocket();
    const options = testConnection(socket);
    const issueTicket = vi.fn(options.issueTicket);
    const chat = new DirectHermesChat({ ...options, issueTicket }); chats.push(chat);
    await Promise.all([chat.connect(), chat.connect()]);
    expect(issueTicket).toHaveBeenCalledTimes(1);
    expect(socket.calls.filter(call => call.method === "session.list")).toHaveLength(1);
    const ticket = deferred<Awaited<ReturnType<typeof options.issueTicket>>>();
    const abandoned = new DirectHermesChat({ ...options, issueTicket: () => ticket.promise }); chats.push(abandoned);
    const connecting = abandoned.connect(); abandoned.dispose();
    ticket.resolve(await options.issueTicket()); await connecting;
    expect(abandoned.getSnapshot().connection).toBe("closed");
    expect(socket.calls.filter(call => call.method === "session.list")).toHaveLength(1);
  });
  it("routes explicit approvals and clarification answers by request ID, surfacing unsupported waits", async () => {
    const { chat, socket } = await setup(); await chat.newSession(); chat.setDraft("Run"); await chat.send();
    socket.handle = method => method === "approval.respond" ? { resolved: 1 } : { status: "ok" };
    socket.event("approval.request", { request_id: "a1", command: "rm example", description: "Confirm command" });
    expect(chat.getSnapshot().active!.interactions[0]).toMatchObject({ type: "approval.request", requestId: "a1" });
    await chat.respond("a1", "once");
    expect(socket.calls.find(call => call.method === "approval.respond")?.params).toEqual({ session_id: "runtime-1", request_id: "a1", choice: "once" });
    socket.event("clarify.request", { request_id: "q1", question: "Which folder?", choices: ["src", "test"] });
    await chat.respond("q1", "src");
    expect(socket.calls.at(-1)).toMatchObject({ method: "clarify.respond", params: { request_id: "q1", answer: "src" } });
    socket.event("sudo.request", { request_id: "s1", prompt: "Password" });
    expect(chat.getSnapshot().active!.interactions[0].type).toBe("sudo.request");
    socket.event("sudo.expire", { request_id: "s1" });
    expect(chat.getSnapshot().active!.interactions).toEqual([]);
    expect(chat.getSnapshot().active!.phase).toBe("running");
  });
  it("requests a scoped stop and waits for terminal confirmation without resubmitting queued work", async () => {
    const { chat, socket } = await setup(); await chat.newSession(); chat.setDraft("Run"); await chat.send();
    socket.handle = () => ({ status: "interrupted" });
    await chat.stop();
    expect(socket.calls.at(-1)).toMatchObject({ method: "session.interrupt", params: { session_id: "runtime-1" } });
    expect(chat.getSnapshot().active!.phase).toBe("stopping");
    socket.event("message.complete", { status: "interrupted", text: "Stopped" });
    expect(chat.getSnapshot().active!.phase).toBe("idle");
    expect(chat.getSnapshot().active!.status).toBe("Stopped");
    expect(socket.calls.find(call => call.method === "prompt.submit")?.params.queued).toBe(true);
  });
  it.each(["session.create", "session.resume", "session.list"])("exposes %s rejection with recoverable loading state", async method => {
    const { chat, socket } = await setup();
    socket.handle = () => { throw new Error("Unavailable"); };
    if (method === "session.create") await expect(chat.newSession()).resolves.toBe(false);
    if (method === "session.resume") await expect(chat.selectSession("saved-a")).resolves.toBe(false);
    if (method === "session.list") await expect(chat.refreshSessions()).resolves.toBe(false);
    expect(chat.getSnapshot().error || chat.getSnapshot().active?.error).toBe("Unavailable");
    expect(chat.getSnapshot().active?.phase).not.toBe("loading");
  });
  it("times out readiness and disposes its connection without leaving a hanging connect", async () => {
    vi.useFakeTimers();
    try {
      const socket = new DirectHermesTestSocket(); socket.autoReady = false;
      const chat = new DirectHermesChat(testConnection(socket)); chats.push(chat);
      const connected = chat.connect();
      await vi.advanceTimersByTimeAsync(15_001);
      await expect(connected).resolves.toBe(false);
      expect(chat.getSnapshot().error).toContain("gateway.ready");
      expect(chat.getSnapshot().connection).toBe("error");
      expect(socket.readyState).toBe(WebSocket.CLOSED);
    } finally { vi.useRealTimers(); }
  });
  it("does not roll back newer live events when a recovery snapshot resolves late", async () => {
    const { chat, socket } = await setup(); await chat.newSession();
    chat.setDraft("Run"); await chat.send();
    const snapshot = deferred<unknown>(); socket.handle = () => snapshot.promise;
    const syncing = chat.syncSession();
    socket.event("message.delta", { text: "Fresh output" });
    socket.event("message.complete", { text: "Fresh final" });
    snapshot.resolve({ session_id: "runtime-1", session_key: "stored-1", running: true, messages: [], inflight: { assistant: "Stale" } });
    await syncing;
    expect(chat.getSnapshot().active!.entries.map(entry => entry.text)).toEqual(["Run", "Fresh final"]);
    expect(chat.getSnapshot().active!.phase).toBe("idle");
  });
  it("waits for gateway.ready before issuing application requests", async () => {
    const socket = new DirectHermesTestSocket(); socket.autoReady = false;
    const chat = new DirectHermesChat(testConnection(socket)); chats.push(chat);
    const connected = chat.connect();
    await vi.waitFor(() => expect(socket.readyState).toBe(WebSocket.OPEN));
    expect(socket.calls).toEqual([]);
    socket.event("gateway.ready", {}, "");
    await connected;
    expect(socket.calls.map(call => call.method)).toEqual(["session.list"]);
  });
  it("reattaches existing runtime snapshots after disconnect without ever resubmitting an ambiguous prompt", async () => {
    const { chat, socket } = await setup(); await chat.newSession();
    const ack = deferred<unknown>(); socket.handle = () => ack.promise;
    chat.setDraft("Maybe accepted"); const sending = chat.send();
    socket.close(); await sending;
    expect(chat.getSnapshot().connection).toBe("closed");
    expect(chat.getSnapshot().active!.phase).toBe("uncertain");
    expect(chat.getSnapshot().active!.draft).toBe("Maybe accepted");
    socket.handle = (method, params) => {
      if (method === "session.list") return { sessions: [] };
      if (method === "session.active_list") return { sessions: [{ id: "runtime-1", session_key: "stored-1" }] };
      if (method === "session.activate") {
        expect(params).toEqual({ session_id: "runtime-1" });
        return { session_id: "runtime-1", session_key: "stored-1", running: true, messages: [], inflight: { user: "Maybe accepted", assistant: "Still working", streaming: true } };
      }
      throw new Error(`Unexpected ${method}`);
    };
    await chat.connect();
    expect(chat.getSnapshot().connection).toBe("open");
    expect(chat.getSnapshot().active!.phase).toBe("running");
    expect(chat.getSnapshot().active!.entries.map(entry => entry.text)).toEqual(["Maybe accepted", "Still working"]);
    expect(chat.getSnapshot().active!.draft).toBe("");
    expect(socket.calls.filter(call => call.method === "prompt.submit")).toHaveLength(1);
    expect(socket.calls.filter(call => call.method === "session.create")).toHaveLength(1);
    socket.event("message.complete", { text: "Recovered final" });
    expect(chat.getSnapshot().active!.phase).toBe("idle");
  });
  it("preserves rejected drafts and cleans up failed requests without stranding a sending turn", async () => {
    const { chat, socket } = await setup(); await chat.newSession();
    socket.handle = () => { throw new Error("Provider unavailable"); };
    chat.setDraft("Keep me");
    await expect(chat.send()).resolves.toBe(false);
    expect(chat.getSnapshot().active).toMatchObject({ draft: "Keep me", phase: "idle", error: "Provider unavailable", entries: [] });
    socket.handle = () => ({ status: "streaming" }); await chat.send();
    socket.event("tool.start", { tool_id: "t1", name: "terminal" });
    socket.event("error", { message: "Worker crashed" });
    expect(chat.getSnapshot().active).toMatchObject({ phase: "uncertain", error: "Worker crashed" });
    expect(chat.getSnapshot().active!.entries.at(-1)?.tool?.status).toBe("unknown");
  });
  it("never duplicates a pending send or clears a newer draft, including completion before ACK", async () => {
    const { chat, socket } = await setup(); await chat.newSession();
    const ack = deferred<unknown>(); socket.handle = () => ack.promise;
    chat.setDraft("First"); const sending = chat.send();
    await chat.send();
    chat.setDraft("Next draft");
    socket.event("message.delta", { text: "Hello" });
    socket.event("message.complete", { text: "Hello!" });
    ack.resolve({ status: "streaming" }); await sending;
    expect(socket.calls.filter(call => call.method === "prompt.submit")).toHaveLength(1);
    expect(chat.getSnapshot().active!.draft).toBe("Next draft");
    expect(chat.getSnapshot().active!.phase).toBe("idle");
    expect(chat.getSnapshot().active!.entries.map(entry => entry.text)).toEqual(["First", "Hello!"]);
  });
  it("lists saved sessions and isolates delayed resume/history results from the selected session and its draft", async () => {
    const { chat, socket } = await setup();
    expect(chat.getSnapshot().sessions.map(session => session.id)).toEqual(["saved-a", "saved-b"]);
    const a = deferred<unknown>();
    const history = deferred<unknown>();
    socket.handle = (method, params) => {
      if (method === "session.resume") return params.session_id === "saved-a" ? a.promise : { session_id: "runtime-b", session_key: "saved-b", running: false, messages: [{ role: "assistant", text: "B history" }] };
      if (method === "session.history") { expect(params).toEqual({ session_id: "runtime-a" }); return history.promise; }
      return { status: "streaming" };
    };
    const loadA = chat.selectSession("saved-a");
    const loadB = chat.selectSession("saved-b");
    await loadB;
    chat.setDraft("Draft B");
    a.resolve({ session_id: "runtime-a", session_key: "saved-a", messages_omitted: true, running: false });
    await vi.waitFor(() => expect(socket.calls.some(call => call.method === "session.history")).toBe(true));
    history.resolve({ messages: [{ role: "user", text: "A question" }, { role: "tool", name: "terminal", context: "pwd", args: { command: "pwd" } }, { role: "assistant", text: "A answer" }] });
    await loadA;
    expect(chat.getSnapshot().active).toMatchObject({ storedId: "saved-b", draft: "Draft B" });
    expect(chat.getSnapshot().active!.entries[0].text).toBe("B history");
    await chat.selectSession("saved-a");
    expect(chat.getSnapshot().active!.entries[1]).toMatchObject({ role: "tool", tool: { name: "terminal", context: "pwd", args: { command: "pwd" }, status: "complete" } });
    expect(chat.getSnapshot().active!.entries[1].tool?.result).toBeUndefined();
    chat.setDraft("Run A"); await chat.send();
    await chat.selectSession("saved-b");
    socket.event("message.complete", { text: "A final" }, "runtime-a");
    expect(chat.getSnapshot().active!.draft).toBe("Draft B");
    expect(chat.getSnapshot().active!.entries).toHaveLength(1);
    await chat.selectSession("saved-a");
    expect(chat.getSnapshot().active!.entries.at(-1)?.text).toBe("A final");
    expect(socket.calls.filter(call => call.method === "session.resume").map(call => call.params)).toEqual([{ session_id: "saved-a" }, { session_id: "saved-b" }]);
  });
  it("streams text and correlates tool lifecycle until message.complete, ignoring unrelated sessions", async () => {
    const { chat, socket } = await setup();
    await chat.newSession(); chat.setDraft("Inspect"); await chat.send();
    socket.event("message.delta", { text: "Wrong session" }, "other-runtime");
    socket.event("message.start", {});
    socket.event("message.delta", { text: "Checking " });
    socket.event("message.delta", { text: "files" });
    expect(chat.getSnapshot().active!.entries.at(-1)?.text).toBe("Checking files");
    socket.event("message.interim", { text: "Checking files" });
    socket.event("tool.start", { tool_id: "t1", name: "terminal", context: "pwd", args: { command: "pwd" } });
    socket.event("tool.progress", { tool_id: "t1", text: "Reading output" });
    expect(chat.getSnapshot().active!.entries.at(-1)).toMatchObject({ role: "tool", tool: { id: "t1", status: "running", progress: "Reading output" } });
    socket.event("tool.complete", { tool_id: "t1", name: "terminal", result: { output: "/project", exit_code: 0 } });
    expect(chat.getSnapshot().active!.phase).toBe("running");
    socket.event("message.delta", { text: "The " });
    socket.event("message.complete", { text: "The project is ready." });
    expect(chat.getSnapshot().active!.phase).toBe("idle");
    expect(chat.getSnapshot().active!.entries.map(entry => entry.text)).toEqual(["Inspect", "Checking files", "", "The project is ready."]);
    expect(chat.getSnapshot().active!.entries[2].tool).toMatchObject({ status: "complete", args: { command: "pwd" }, result: { output: "/project", exit_code: 0 } });
  });
  it("uses the created runtime ID, clears an accepted draft, and keeps streaming after the prompt ACK", async () => {
    const { chat, socket } = await setup();
    await chat.newSession();
    chat.setDraft("Check the project");
    await chat.send();
    expect(socket.calls.find(call => call.method === "session.create")?.params).toEqual({ source: "desktop", close_on_disconnect: false });
    expect(socket.calls.find(call => call.method === "prompt.submit")?.params).toEqual({ session_id: "runtime-1", text: "Check the project", queued: true });
    const active = chat.getSnapshot().active!;
    expect(active.storedId).toBe("stored-1");
    expect(active.runtimeId).toBe("runtime-1");
    expect(active.draft).toBe("");
    expect(active.phase).toBe("running");
    expect(active.entries).toContainEqual(expect.objectContaining({ role: "user", text: "Check the project" }));
    expect(active.entries.filter(entry => entry.role === "assistant")).toEqual([]);
  });
});
