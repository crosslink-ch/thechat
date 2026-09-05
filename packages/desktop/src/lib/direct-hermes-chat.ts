import { connectDirectHermesGateway, type DirectHermesGatewayConnectionOptions } from "./direct-hermes-gateway";
import { JsonRpcGatewayError, type ConnectionState, type GatewayEvent, type JsonRpcGatewayClient } from "./hermes-json-rpc-gateway";
import { parseDirectHermesSessions, type DirectHermesSession } from "./direct-hermes-sessions";
import { commandParts, DIRECT_COMMANDS, GATEWAY_SLASH_COMMANDS, parseCommandCatalog, renderCommandResult, type DirectCommandCatalog } from "./direct-hermes-commands";

// The opaque proxy caps each JSON frame at 4 MiB. Base64 expands these bytes;
// 2 MiB leaves room for JSON and filenames. Upload sequentially, never batch.
export const DIRECT_HERMES_ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024;
export const DIRECT_HERMES_ATTACHMENT_MAX_COUNT = 5;

export interface DirectHermesTool {
  id: string;
  name: string;
  context: string;
  args?: unknown;
  result?: unknown;
  progress?: string;
  status: "running" | "complete" | "unknown";
}

export interface DirectHermesEntry {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  tool?: DirectHermesTool;
  attachments?: DirectHermesAttachment[];
}
export interface DirectHermesAttachment {
  id: string;
  name: string;
  size: number;
  type: "image" | "file";
  status: "queued" | "uploading" | "ready" | "error" | "uncertain";
  error?: string;
  file?: File;
}
export interface DirectHermesChatSession {
  attachments?: DirectHermesAttachment[];
  interactions: DirectHermesInteraction[];
  key: string;
  storedId: string;
  runtimeId: string;
  title?: string;
  draft: string;
  phase: "loading" | "idle" | "sending" | "running" | "uncertain" | "stopping";
  status?: string;
  error?: string;
  entries: DirectHermesEntry[];
  streamId?: string;
  pendingText?: string;
  submitting?: boolean;
}
export interface DirectHermesChatSnapshot {
  commands?: { name: string; description: string }[];
  active: DirectHermesChatSession | null;
  sessions: DirectHermesSession[];
  opened: DirectHermesChatSession[];
  connection: ConnectionState;
  error?: string;
  listing?: boolean;
}
export interface DirectHermesInteraction {
  type: string;
  requestId: string;
  payload: Record<string, unknown>;
  pending?: boolean;
  error?: string;
}

/** Ephemeral renderer state only. Hermes remains the transcript authority. */
export class DirectHermesChat {
  private client: JsonRpcGatewayClient | null = null;
  private state: DirectHermesChatSnapshot = { active: null, sessions: [], opened: [], connection: "idle" };
  private listeners = new Set<() => void>();
  private lifetime = new AbortController();
  private nextId = 0;
  private revisions = new WeakMap<DirectHermesChatSession, number>();
  private navigation = 0;
  private earlyEvents: GatewayEvent[] = [];
  private uploaded = new WeakMap<DirectHermesAttachment, { runtimeId: string; generation: number; path: string; refText: string; imagePending?: boolean }>();
  private recovery = new WeakMap<DirectHermesChatSession, { kind: "cleanup" | "image" | "prompt" | "command"; message: string }>();
  private commandCatalog?: DirectCommandCatalog;
  private sending = new WeakMap<DirectHermesChatSession, { cancelled: boolean; promptAttempted: boolean }>();
  private pendingPrompts = new WeakMap<DirectHermesChatSession, { draft: string; text: string; attachments: DirectHermesAttachment[]; usersBefore: number }>();
  constructor(private options: DirectHermesGatewayConnectionOptions) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish() {
    this.state.opened.forEach(session => {
      const recovery = this.recovery.get(session);
      if (recovery) { session.phase = "uncertain"; session.error = recovery.message; }
    });
    this.state = { ...this.state }; this.listeners.forEach(listener => listener());
  }
  private connecting: Promise<boolean> | null = null;
  private disposed = false;
  private generation = 0;
  private cleanups: (() => void)[] = [];
  connect(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this.connecting) return this.connecting;
    if (this.state.connection === "open") return Promise.resolve(true);
    this.connecting = this.dial().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  private async dial() {
    const generation = ++this.generation;
    const current = () => !this.disposed && generation === this.generation;
    this.cleanups.splice(0).forEach(unsubscribe => unsubscribe());
    this.client?.close();
    this.state.connection = "connecting";
    this.state.error = undefined;
    this.publish();
    const attempt = new AbortController();
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const timer = setTimeout(() => readyReject(new Error("Timed out waiting for Hermes gateway.ready")), 15_000);
    const onAbort = () => { attempt.abort(); readyReject(new Error("Connection cancelled")); };
    this.lifetime.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const opening = connectDirectHermesGateway({
        ...this.options, signal: attempt.signal,
        onClient: client => {
          if (!current()) return;
          this.client = client;
          this.cleanups.push(client.onState(state => {
            if (state === "closed" || state === "error") readyReject(new Error("Hermes connection closed before readiness"));
          }));
          this.cleanups.push(client.onEvent(event => {
            if (!current()) return;
            if (event.type === "gateway.ready") readyResolve();
            else this.onEvent(event);
          }));
        },
      });
      const [client] = await Promise.all([opening, ready]);
      clearTimeout(timer);
      if (!current()) { client.close(); return false; }
      this.cleanups.push(client.onState(connection => {
        if (!current()) return;
        this.state.connection = connection;
        if (connection === "closed" || connection === "error") {
          this.state.opened.forEach(session => {
            session.phase = "uncertain";
            session.error = "Connection lost. Reconnect to check Hermes; prompts are never automatically resent.";
            session.entries.forEach(entry => { if (entry.tool?.status === "running") entry.tool.status = "unknown"; });
          });
        }
        this.publish();
      }));
      await this.refreshSessions();
      if (!current()) return false;
      if (this.state.opened.length) {
        const live = record(await client.request("session.active_list", {}, undefined, this.lifetime.signal));
        if (!current()) return false;
        const rows = Array.isArray(live.sessions) ? live.sessions.map(record) : [];
        await Promise.all(this.state.opened.map(async session => {
          const revision = this.revisions.get(session) ?? 0;
          const existing = rows.find(row => row.id === session.runtimeId || row.session_key === session.storedId);
          const result = record(await client.request(existing ? "session.activate" : "session.resume", { session_id: existing ? existing.id : session.storedId }, undefined, this.lifetime.signal));
          if (current()) await this.adoptSnapshot(session, result, revision);
        }));
      }
      return true;
    } catch (error) {
      attempt.abort();
      if (!current()) return false;
      this.client?.close();
      this.state.connection = "error";
      this.state.error = errorMessage(error);
      this.publish();
      return false;
    } finally {
      clearTimeout(timer);
      this.lifetime.signal.removeEventListener("abort", onAbort);
    }
  }
  async refreshSessions() {
    this.state.listing = true; this.state.error = undefined; this.publish();
    try {
      this.state.sessions = parseDirectHermesSessions(await this.client!.request("session.list", { limit: 200 }, undefined, this.lifetime.signal));
      return true;
    } catch (error) { this.state.error = errorMessage(error); return false; }
    finally { this.state.listing = false; this.publish(); }
  }
  async refreshCommands() {
    try {
      const result = record(await this.client!.request("commands.catalog", {}, undefined, this.lifetime.signal));
      this.commandCatalog = parseCommandCatalog(result);
      this.state.commands = this.commandCatalog.commands;
      this.publish(); return true;
    } catch { return false; }
  }
  async selectSession(id: string) {
    this.navigation++;
    let session = this.state.opened.find(session => session.key === id || session.storedId === id);
    if (session) { this.state.active = session; this.publish(); return; }
    session = { key: id, storedId: id, runtimeId: "", draft: "", phase: "loading", entries: [], interactions: [] };
    this.state.opened.push(session);
    this.state.active = session;
    this.publish();
    try {
      const result = record(await this.client!.request("session.resume", { session_id: id }, undefined, this.lifetime.signal));
      await this.adoptSnapshot(session, result);
      return true;
    } catch (error) { session.phase = "uncertain"; session.error = errorMessage(error); this.publish(); return false; }
  }
  async syncSession() {
    const session = this.state.active;
    if (!session || session.submitting) return false;
    const revision = this.revisions.get(session) ?? 0;
    try {
      const resume = () => this.client!.request("session.resume", {
        session_id: session.storedId, source: "desktop", close_on_disconnect: false,
      }, undefined, this.lifetime.signal);
      let raw: unknown;
      if (!session.runtimeId) {
        raw = await resume();
      } else {
        try {
          raw = await this.client!.request("session.activate", { session_id: session.runtimeId }, undefined, this.lifetime.signal);
        } catch (error) {
          // Only a definitive missing-runtime reply allows rebinding. Never
          // retry an ambiguous mutation or resubmit a prompt during recovery.
          if (!(error instanceof JsonRpcGatewayError) || error.code !== 4001) throw error;
          raw = await resume();
        }
      }
      await this.adoptSnapshot(session, record(raw), revision);
      return true;
    } catch (error) { session.error = errorMessage(error); this.publish(); return false; }
  }
  private async adoptSnapshot(session: DirectHermesChatSession, result: Record<string, unknown>, revision = this.revisions.get(session) ?? 0) {
    if (!string(result.session_id)) throw new Error("Hermes returned an invalid runtime session ID");
    session.runtimeId = string(result.session_id);
    session.storedId = string(result.stored_session_id) || string(result.session_key) || string(result.resumed) || session.storedId;
    const messages = result.messages_omitted || !Array.isArray(result.messages)
      ? record(await this.client!.request("session.history", { session_id: session.runtimeId })).messages
      : result.messages;
    if (revision !== (this.revisions.get(session) ?? 0)) return;
    session.entries = projectHistory(messages);
    session.phase = result.running ? "running" : "idle";
    session.error = undefined;
    session.streamId = undefined;
    session.title = string(record(result.info).title) || session.title;
    session.interactions = [];
    if (result.pending_approval) this.addInteraction(session, "approval.request", record(result.pending_approval));
    if (result.pending_clarify) this.addInteraction(session, "clarify.request", record(result.pending_clarify));
    const inflight = record(result.inflight);
    if (string(inflight.user) && session.entries.at(-1)?.text !== inflight.user) session.entries.push({ id: `local-${++this.nextId}`, role: "user", text: string(inflight.user) });
    if (string(inflight.assistant)) {
      session.streamId = `local-${++this.nextId}`;
      session.entries.push({ id: session.streamId, role: "assistant", text: string(inflight.assistant) });
    }
    const pending = this.pendingPrompts.get(session);
    // A matching OLD message is not evidence that this particular send ran.
    // Require a new user row (or inflight user) beyond the captured boundary.
    if (pending && session.entries.filter(entry => entry.role === "user").slice(pending.usersBefore).some(entry => entry.text === pending.text)) {
      this.acceptPrompt(session, pending.draft, pending.attachments);
      if (this.recovery.get(session)?.kind === "prompt") this.recovery.delete(session);
    }
    const buffered = this.earlyEvents.filter(event => event.session_id === session.runtimeId);
    this.earlyEvents = this.earlyEvents.filter(event => event.session_id !== session.runtimeId);
    buffered.forEach(event => this.onEvent(event));
    const recovery = this.recovery.get(session);
    if (recovery?.kind === "cleanup" && !result.running) {
      try { await this.detachImages(session.attachments ?? []); this.recovery.delete(session); }
      catch (error) { recovery.message = `Image cleanup unconfirmed: ${errorMessage(error)}`; }
    }
    if (this.recovery.has(session)) { session.phase = "uncertain"; session.error = this.recovery.get(session)!.message; }
    this.publish();
  }
  private onEvent(event: GatewayEvent) {
    if (event.type === "sessions.changed") { void this.refreshSessions(); return; }
    const session = this.state.opened.find(session => session.runtimeId === event.session_id);
    if (!session) {
      // A resumed runtime can emit before the correlated response gives us R.
      // Keep a bounded, ephemeral handoff buffer only while a binding loads.
      if (event.session_id && this.state.opened.some(item => item.phase === "loading")) this.earlyEvents = [...this.earlyEvents, event].slice(-256);
      return;
    }
    const payload = record(event.payload);
    if (event.type === "session.info") {
      session.storedId = string(payload.stored_session_id) || session.storedId;
      session.title = string(payload.title) || session.title;
      if (payload.running === true && session.phase === "idle") session.phase = "running";
      this.publish();
      return;
    }
    this.revisions.set(session, (this.revisions.get(session) ?? 0) + 1);
    if (event.type.endsWith(".request")) this.addInteraction(session, event.type, payload);
    if (event.type.endsWith(".expire")) session.interactions = session.interactions.filter(item => item.requestId !== payload.request_id);
    if (event.type === "error") {
      session.error = string(payload.message) || "Hermes reported an error";
      session.phase = "uncertain";
      session.entries.forEach(entry => { if (entry.tool?.status === "running") entry.tool.status = "unknown"; });
    }
    if (["message.delta", "message.interim", "message.complete"].includes(event.type)) {
      const text = string(payload.text);
      let entry = session.entries.find(entry => entry.id === session.streamId);
      if (!entry && text) {
        entry = { id: `local-${++this.nextId}`, role: "assistant", text: "" };
        session.streamId = entry.id;
        session.entries.push(entry);
      }
      if (entry) entry.text = event.type === "message.delta" ? entry.text + text : text || entry.text;
      if (event.type !== "message.delta") session.streamId = undefined;
      if (event.type === "message.complete") {
        session.phase = "idle";
        session.interactions = [];
        session.status = payload.status === "interrupted" ? "Stopped" : "Complete";
        if (payload.status === "error") session.error = string(payload.error) || text || "Hermes turn failed";
      }
    }
    if (["tool.start", "tool.progress", "tool.complete"].includes(event.type) && string(payload.tool_id)) {
      const id = string(payload.tool_id);
      let entry = session.entries.find(entry => entry.tool?.id === id);
      if (!entry) {
        entry = { id: `local-${++this.nextId}`, role: "tool", text: "", tool: { id, name: string(payload.name) || "Tool", context: string(payload.context), status: "running" } };
        session.entries.push(entry);
      }
      const tool = entry.tool!;
      if (payload.args !== undefined) tool.args = payload.args;
      if (payload.result !== undefined) tool.result = payload.result;
      if (string(payload.text)) tool.progress = string(payload.text);
      if (event.type === "tool.complete") tool.status = "complete";
    }
    this.publish();
  }
  async newSession() {
    const navigation = ++this.navigation;
    try {
      const result = await this.client!.request<{ session_id: string; stored_session_id: string }>("session.create", { source: "desktop", close_on_disconnect: false }, undefined, this.lifetime.signal);
      const session: DirectHermesChatSession = { key: result.stored_session_id, storedId: result.stored_session_id, runtimeId: result.session_id, draft: "", phase: "idle", entries: [], interactions: [] };
      this.state.opened.push(session);
      if (navigation === this.navigation) this.state.active = session;
      this.publish();
      return true;
    } catch (error) { this.state.error = errorMessage(error); this.publish(); return false; }
  }
  setDraft(draft: string) { if (this.state.active) { this.state.active.draft = draft; this.publish(); } }
  async addAttachments(files: File[]) {
    const session = this.state.active;
    if (!session || this.disposed) return false;
    const error = files.some(file => file.size > DIRECT_HERMES_ATTACHMENT_MAX_BYTES)
      ? "Attachments must be 2 MiB or smaller per file."
      : (session.attachments?.length ?? 0) + files.length > DIRECT_HERMES_ATTACHMENT_MAX_COUNT
        ? "A session can have at most 5 pending attachments." : undefined;
    if (error) { session.error = error; this.publish(); return false; }
    session.error = undefined;
    session.attachments = [...(session.attachments ?? []), ...files.map(file => ({
      id: `attachment-${++this.nextId}`, name: file.name, size: file.size,
      type: /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif)$/i.test(file.name) ? "image" as const : "file" as const,
      status: "queued" as const, file,
    }))];
    this.publish();
    return true;
  }
  async removeAttachment(id: string) {
    const session = this.state.active;
    if (!session || session.submitting) return false;
    const attachment = session.attachments?.find(item => item.id === id);
    if (!attachment) return false;
    if (this.recovery.get(session)?.kind === "image" || this.recovery.get(session)?.kind === "prompt") return false;
    try { if (this.uploaded.get(attachment)?.imagePending) await this.detachImages([attachment]); }
    catch (error) { session.error = `Image cleanup unconfirmed: ${errorMessage(error)}`; this.publish(); return false; }
    session.attachments = (session.attachments ?? []).filter(item => item.id !== id);
    if (this.recovery.get(session)?.kind === "cleanup" && !session.attachments.some(item => this.uploaded.get(item)?.imagePending)) { this.recovery.delete(session); session.phase = "idle"; }
    this.publish();
    return true;
  }
  canSend() {
    const session = this.state.active;
    const stopping = /^\/(stop|interrupt)\s*$/i.test(session?.draft.trim() ?? "") && session?.phase === "running";
    return !!session && !session.submitting && !this.recovery.has(session) && (session.phase === "idle" || stopping) && !!session.runtimeId
      && !(session.draft.trimStart().startsWith("/") && session.attachments?.length)
      && this.state.connection === "open" && !!(session.draft.trim() || session.attachments?.length);
  }
  private async detachImages(attachments: DirectHermesAttachment[]) {
    for (const attachment of attachments) {
      const uploaded = this.uploaded.get(attachment);
      if (!uploaded?.imagePending) continue;
      if (uploaded.generation !== this.generation) throw new Error("Original gateway binding for image cleanup is no longer confirmed. Use a new session; this cleanup obligation is retained.");
      const ack = record(await this.client!.request("image.detach", { session_id: uploaded.runtimeId, path: uploaded.path }, undefined, this.lifetime.signal));
      // detached:false is a successful idempotent cleanup, not a rejection.
      if (typeof ack.detached !== "boolean") throw new Error("Hermes did not confirm image cleanup. Sync before sending.");
      uploaded.imagePending = false;
      attachment.status = "ready";
    }
  }
  private addInteraction(session: DirectHermesChatSession, type: string, payload: Record<string, unknown>) {
    const requestId = string(payload.request_id);
    if (!requestId || session.interactions.some(item => item.requestId === requestId)) return;
    session.interactions.push({ type, requestId, payload });
    session.phase = "running";
    if (type === "approval.request") void this.client?.request("approval.received", { session_id: session.runtimeId, request_id: requestId }, 15_000, this.lifetime.signal).catch(() => {});
  }
  async respond(requestId: string, value: string) {
    const session = this.state.active;
    const interaction = session?.interactions.find(item => item.requestId === requestId);
    if (!session || !interaction || interaction.pending || this.state.connection !== "open") return false;
    const approval = interaction.type === "approval.request";
    if (approval ? !["once", "deny"].includes(value) : interaction.type !== "clarify.request") return false;
    interaction.pending = true; interaction.error = undefined; this.publish();
    try {
      const result = record(await this.client!.request(approval ? "approval.respond" : "clarify.respond", approval
        ? { session_id: session.runtimeId, request_id: requestId, choice: value }
        : { request_id: requestId, answer: value }, undefined, this.lifetime.signal));
      if (approval && !(typeof result.resolved === "number" && result.resolved > 0)) throw new Error("Approval is no longer pending. Sync the session before trying again.");
      session.interactions = session.interactions.filter(item => item !== interaction);
      return true;
    } catch (error) { interaction.error = errorMessage(error); return false; }
    finally { interaction.pending = false; this.publish(); }
  }
  async stop() {
    const session = this.state.active;
    const sending = session && this.sending.get(session);
    if (session && sending && !sending.promptAttempted) {
      sending.cancelled = true;
      session.phase = "stopping"; session.status = "Cancelling attachment send; waiting for upload acknowledgement.";
      this.publish(); return true;
    }
    if (!session?.runtimeId || session.phase === "stopping" || session.phase === "idle") return false;
    session.phase = "stopping"; session.error = undefined; this.publish();
    try {
      await this.client!.request("session.interrupt", { session_id: session.runtimeId }, undefined, this.lifetime.signal);
      // The interrupt ACK requests cancellation; only a terminal event or a
      // fresh live snapshot proves the worker has actually stopped.
      return true;
    } catch (error) { session.phase = "uncertain"; session.error = errorMessage(error); this.publish(); return false; }
  }
  private async sendCommand(session: DirectHermesChatSession, command: string) {
    const navigation = this.navigation;
    const draft = session.draft;
    const first = commandParts(command);
    if (["stop", "interrupt"].includes(first.name) && !first.arg) {
      const stopped = await this.stop();
      if (stopped && session.draft === draft) session.draft = "";
      this.publish(); return stopped;
    }
    const runtimeId = session.runtimeId;
    const generation = this.generation;
    const assertCurrent = () => {
      if (this.disposed || this.generation !== generation || session.runtimeId !== runtimeId) throw new Error("Gateway binding changed; command outcome may be unknown.");
    };
    const request = async (method: string, params: Record<string, unknown>) => {
      assertCurrent();
      const result = record(await this.client!.request(method, params, undefined, this.lifetime.signal));
      assertCurrent(); return result;
    };
    const render = (name: string, text: string) => session.entries.push({ id: `local-${++this.nextId}`, role: "system", text: `/${name}\n${text}` });
    const visited = new Set<string>();
    const run = async (invocation: string): Promise<boolean> => {
      const parsed = commandParts(invocation);
      if (visited.has(parsed.name) || visited.size >= 8) throw new CommandInputError("Command alias recursion/cycle limit reached. Nothing was submitted.");
      visited.add(parsed.name);
      if (!DIRECT_COMMANDS.has(parsed.name) && !this.commandCatalog) await this.refreshCommands();
      assertCurrent();
      let name = this.commandCatalog?.canon.get(parsed.name) || parsed.name;
      const arg = parsed.arg;
      const dynamic = this.commandCatalog?.dynamic.has(name);
      if (!DIRECT_COMMANDS.has(name) && !dynamic) {
        const resolved = await request("command.resolve", { name });
        name = string(resolved.canonical) || name;
      }
      if (["new", "reset", "clear", "status"].includes(name) && arg) throw new CommandInputError(`/${name} arguments are not supported here. Start a new session and use /title to name it.`);
      if (["branch", "fork", "new", "reset", "clear"].includes(name)) {
        const fresh = ["new", "reset", "clear"].includes(name);
        const result = await request(fresh ? "session.create" : "session.branch", fresh
          ? { source: "desktop", close_on_disconnect: false }
          : { session_id: runtimeId, name: arg });
        if (!string(result.session_id) || !string(result.stored_session_id)) throw new Error("Hermes returned an invalid session acknowledgement. Sync before retrying.");
        const child: DirectHermesChatSession = { key: string(result.stored_session_id), storedId: string(result.stored_session_id), runtimeId: string(result.session_id), title: string(result.title), draft: "", phase: "loading", entries: [], interactions: [], attachments: [] };
        this.state.opened.push(child);
        await this.adoptSnapshot(child, result);
        assertCurrent();
        if (navigation === this.navigation && this.state.active === session) { this.navigation++; this.state.active = child; }
        await Promise.all([this.refreshSessions(), this.refreshCommands()]);
      } else if (["help", "commands"].includes(name)) {
        await this.refreshCommands(); assertCurrent();
        render(name, "Direct Hermes commands (local desktop-only commands are unsupported):\n" + (this.state.commands ?? []).map(item => `${item.name} — ${item.description}`).join("\n"));
      } else {
        let result: Record<string, unknown>;
        if (dynamic) {
          result = await request("command.dispatch", { session_id: runtimeId, name, arg });
        } else if (["title", "status", "model"].includes(name) || GATEWAY_SLASH_COMMANDS.has(name)) {
          const method = name === "title" ? "session.title" : name === "status" ? "session.status" : name === "model" && arg ? "config.set" : "slash.exec";
          const params = name === "title" ? (arg ? { title: arg } : {}) : name === "status" ? {} : name === "model" && arg ? { key: "model", value: arg } : { command: `${name}${arg ? ` ${arg}` : ""}` };
          result = await request(method, { session_id: runtimeId, ...params });
          if (name === "title" && typeof result.title === "string") session.title = result.title;
        } else { throw new CommandInputError(`/${name} is not supported in Direct Hermes. Use the native Hermes client for local UI commands.`); }
        if ((dynamic && !string(result.type)) || (result.type !== undefined && !["alias", "exec", "plugin", "skill", "send", "prefill"].includes(string(result.type)))) throw new Error("Unsupported or invalid command dispatch response. Inspect Hermes before retrying.");
        if (result.type === "alias") {
          if (!string(result.target).trim()) throw new CommandInputError("Invalid empty command alias target");
          return run(`/${string(result.target).replace(/^\//, "")}${arg ? ` ${arg}` : ""}`);
        }
        if (string(result.notice)) render(name, string(result.notice));
        if (result.type === "prefill") {
          if (!string(result.message)) throw new Error("Hermes returned an empty prefill message");
          if (session.draft === draft) session.draft = string(result.message);
          else render(name, `Restored prompt (your newer draft was kept):\n${string(result.message)}`);
          session.phase = "idle"; return true;
        }
        if (result.type === "skill" || result.type === "send") {
          if (!string(result.message)) throw new Error("Hermes returned an empty command message");
          return this.submitPrompt(session, draft, string(result.message), [], string(result.display) || command);
        }
        render(name, renderCommandResult(result));
      }
      session.phase = "idle";
      if (session.draft === draft) session.draft = "";
      return true;
    };
    session.submitting = true; session.phase = "sending"; session.error = undefined; this.publish();
    try { return await run(command); }
    catch (error) {
      session.error = errorMessage(error);
      const definite = error instanceof CommandInputError || (error instanceof JsonRpcGatewayError && typeof error.code === "number" && error.code < 5000);
      session.phase = definite ? "idle" : "uncertain";
      if (!definite) {
        session.error = `Command outcome unknown: ${session.error}. No fallback or replay was attempted. Sync to inspect; use a new session if it cannot be confirmed.`;
        this.recovery.set(session, { kind: "command", message: session.error });
      }
      return false;
    }
    finally { session.submitting = false; this.publish(); }
  }
  async send() {
    const session = this.state.active;
    if (session?.draft.trimStart().startsWith("/") && session.attachments?.length) {
      session.error = "Send attachments and slash commands separately; no files were uploaded."; this.publish(); return false;
    }
    if (!session || !this.canSend()) return false;
    if (session.draft.trimStart().startsWith("/")) return this.sendCommand(session, session.draft.trim());
    return this.submitPrompt(session, session.draft, session.draft, [...(session.attachments ?? [])]);
  }
  private async submitPrompt(session: DirectHermesChatSession, draft: string, prompt: string, attachments: DirectHermesAttachment[], display?: string) {
    session.submitting = true;
    const sending = { cancelled: false, promptAttempted: false };
    this.sending.set(session, sending);
    const assertNotCancelled = () => { if (sending.cancelled) throw new UploadCancelled("Attachment send cancelled. Your draft and files were kept."); };
    let text = prompt.trim() ? prompt : "Please review the attached files.";
    const runtimeId = session.runtimeId;
    const generation = this.generation;
    const assertCurrent = () => {
      if (this.disposed || generation !== this.generation || runtimeId !== session.runtimeId) throw new Error("Sending cancelled because the gateway binding changed. Nothing was replayed.");
    };
    let stage: "file" | "image" | "prompt" = "file";
    const usersBefore = session.entries.filter(entry => entry.role === "user").length;
    const id = `local-${++this.nextId}`;
    session.phase = "sending";
    session.error = undefined;
    session.entries = [...session.entries, { id, role: "user", text: display ?? text, ...(attachments.length ? { attachments } : {}) }];
    this.publish();
    try {
      for (const attachment of attachments) {
        const existing = this.uploaded.get(attachment);
        if (existing?.runtimeId === runtimeId && existing.generation === generation) continue;
        attachment.status = "uploading"; attachment.error = undefined; this.publish();
        const dataUrl = await readAttachment(attachment.file!);
        assertCurrent();
        assertNotCancelled();
        const result = record(await this.client!.request("file.attach", { session_id: runtimeId, name: attachment.name, data_url: dataUrl }, undefined, this.lifetime.signal));
        assertCurrent();
        if (result.attached !== true || !string(result.path) || !string(result.ref_text)) throw new Error("Hermes returned an invalid file attachment acknowledgement");
        this.uploaded.set(attachment, { runtimeId, generation, path: string(result.path), refText: string(result.ref_text) });
        attachment.status = "ready"; this.publish();
        assertNotCancelled();
      }
      for (const attachment of attachments.filter(item => item.type === "image")) {
        assertCurrent();
        assertNotCancelled();
        stage = "image";
        const uploaded = this.uploaded.get(attachment)!;
        uploaded.imagePending = true;
        const result = record(await this.client!.request("image.attach", { session_id: runtimeId, path: uploaded.path }, undefined, this.lifetime.signal));
        assertCurrent();
        if (result.attached !== true || result.path !== uploaded.path) throw new Error("Hermes did not confirm the expected image path. Sync before sending.");
        assertNotCancelled();
      }
      text = [text, ...attachments.filter(item => item.type === "file").map(attachment => this.uploaded.get(attachment)!.refText)].join("\n\n");
      session.pendingText = text;
      stage = "prompt";
      assertCurrent();
      assertNotCancelled();
      sending.promptAttempted = true;
      this.pendingPrompts.set(session, { draft, text, attachments, usersBefore });
      const ack = record(await this.client!.request("prompt.submit", { session_id: runtimeId, text, queued: true }, undefined, this.lifetime.signal));
      if (!["streaming", "queued", "redirected", "steered"].includes(string(ack.status))) throw new Error("Hermes returned an unrecognized prompt acknowledgement. Sync before retrying.");
      this.acceptPrompt(session, draft, attachments);
      // Events can finish a fast turn before its correlated ACK arrives.
      if (session.phase === "sending") session.phase = "running";
      this.publish();
      return true;
    } catch (error) {
      session.error = error instanceof Error ? error.message : "Hermes request failed";
      session.phase = error instanceof JsonRpcGatewayError ? "idle" : "uncertain";
      if (stage === "file") {
        // file.attach only stages bytes; it never queues images or submits a
        // prompt. An ACK loss may orphan a file, but retry cannot run a turn.
        session.phase = "idle";
        session.entries = session.entries.filter(entry => entry.id !== id);
        attachments.filter(item => item.status === "uploading").forEach(item => { item.status = "error"; item.error = session.error; });
      }
      if (error instanceof JsonRpcGatewayError || error instanceof UploadCancelled) {
        session.phase = "idle";
        session.pendingText = undefined;
        this.pendingPrompts.delete(session);
        session.entries = session.entries.filter(entry => entry.id !== id);
        try { await this.detachImages(attachments); }
        catch (cleanupError) {
          session.phase = "uncertain"; session.error += ` Image cleanup unconfirmed: ${errorMessage(cleanupError)}`;
          this.recovery.set(session, { kind: "cleanup", message: session.error });
          attachments.filter(item => this.uploaded.get(item)?.imagePending).forEach(item => { item.status = "uncertain"; item.error = session.error; });
        }
      } else if ((attachments.length || display !== undefined) && stage !== "file") {
        session.error = `Outcome unknown: ${session.error}. Nothing was replayed. Sync to inspect Hermes; use a new session if the outcome cannot be confirmed.`;
        this.recovery.set(session, { kind: stage, message: session.error });
        attachments.forEach(item => { item.status = "uncertain"; item.error = session.error; });
      }
      this.publish();
      return false;
    } finally {
      this.sending.delete(session);
      session.submitting = false;
      this.publish();
    }
  }
  dispose() {
    this.disposed = true;
    this.generation++;
    this.cleanups.splice(0).forEach(unsubscribe => unsubscribe());
    this.lifetime.abort(); this.client?.close();
    this.state.connection = "closed";
    this.publish(); this.listeners.clear();
  }
  private acceptPrompt(session: DirectHermesChatSession, draft: string, attachments: DirectHermesAttachment[]) {
    if (session.draft === draft) session.draft = "";
    attachments.forEach(attachment => { const uploaded = this.uploaded.get(attachment); if (uploaded) uploaded.imagePending = false; });
    session.attachments = (session.attachments ?? []).filter(item => !attachments.some(sent => sent.id === item.id));
    session.pendingText = undefined;
    this.pendingPrompts.delete(session);
  }
}

class CommandInputError extends Error {}
class UploadCancelled extends Error {}
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function string(value: unknown) { return typeof value === "string" ? value : ""; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "Hermes request failed"; }

function readAttachment(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onabort = () => reject(new Error(`Reading ${file.name} was cancelled`));
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

// Hermes' display projection deliberately omits stored tool output. Do not
// invent a result or interpret those tool rows as empty assistant messages.
function projectHistory(value: unknown): DirectHermesEntry[] {
  if (!Array.isArray(value)) throw new Error("Hermes returned invalid session history");
  return value.flatMap((raw, index): DirectHermesEntry[] => {
    const row = record(raw);
    const id = `history-${index}`;
    if (row.role === "tool") return [{ id, role: "tool", text: "", tool: { id, name: string(row.name) || "Tool", context: string(row.context), args: row.args, status: "complete" } }];
    if (["user", "assistant", "system"].includes(string(row.role)) && row.display_kind !== "hidden") return [{ id, role: row.role as "user" | "assistant" | "system", text: string(row.text) }];
    return [];
  });
}
