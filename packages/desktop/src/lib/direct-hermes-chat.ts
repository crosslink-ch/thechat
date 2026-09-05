import { connectDirectHermesGateway, type DirectHermesGatewayConnectionOptions } from "./direct-hermes-gateway";
import { JsonRpcGatewayError, type ConnectionState, type GatewayEvent, type JsonRpcGatewayClient } from "./hermes-json-rpc-gateway";
import { parseDirectHermesSessions, type DirectHermesSession } from "./direct-hermes-sessions";

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
}
export interface DirectHermesChatSession {
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
  constructor(private options: DirectHermesGatewayConnectionOptions) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish() { this.state = { ...this.state }; this.listeners.forEach(listener => listener()); }
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
    if (!session) return;
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
    if (session.pendingText && session.entries.some(entry => entry.role === "user" && entry.text === session.pendingText)) {
      if (session.draft === session.pendingText) session.draft = "";
      session.pendingText = undefined;
    }
    const buffered = this.earlyEvents.filter(event => event.session_id === session.runtimeId);
    this.earlyEvents = this.earlyEvents.filter(event => event.session_id !== session.runtimeId);
    buffered.forEach(event => this.onEvent(event));
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
    if (!session?.runtimeId || session.phase === "stopping" || session.phase === "idle") return false;
    session.phase = "stopping"; session.error = undefined; this.publish();
    try {
      await this.client!.request("session.interrupt", { session_id: session.runtimeId }, undefined, this.lifetime.signal);
      // The interrupt ACK requests cancellation; only a terminal event or a
      // fresh live snapshot proves the worker has actually stopped.
      return true;
    } catch (error) { session.phase = "uncertain"; session.error = errorMessage(error); this.publish(); return false; }
  }
  async send() {
    const session = this.state.active;
    if (!session || session.submitting || session.phase !== "idle" || !session.draft.trim() || this.state.connection !== "open") return false;
    session.submitting = true;
    const text = session.draft;
    session.pendingText = text;
    const id = `local-${++this.nextId}`;
    session.phase = "sending";
    session.error = undefined;
    session.entries = [...session.entries, { id, role: "user", text }];
    this.publish();
    try {
      const ack = record(await this.client!.request("prompt.submit", { session_id: session.runtimeId, text, queued: true }, undefined, this.lifetime.signal));
      if (!["streaming", "queued", "redirected", "steered"].includes(string(ack.status))) throw new Error("Hermes returned an unrecognized prompt acknowledgement. Sync before retrying.");
      if (session.draft === text) session.draft = "";
      session.pendingText = undefined;
      // Events can finish a fast turn before its correlated ACK arrives.
      if (session.phase === "sending") session.phase = "running";
      this.publish();
      return true;
    } catch (error) {
      session.error = error instanceof Error ? error.message : "Hermes request failed";
      session.phase = error instanceof JsonRpcGatewayError ? "idle" : "uncertain";
      if (error instanceof JsonRpcGatewayError) session.entries = session.entries.filter(entry => entry.id !== id);
      this.publish();
      return false;
    } finally {
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
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function string(value: unknown) { return typeof value === "string" ? value : ""; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "Hermes request failed"; }

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
