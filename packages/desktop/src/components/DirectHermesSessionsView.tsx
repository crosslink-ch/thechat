import { useEffect, useRef } from "react";
import type { DirectHermesChatSession } from "../lib/direct-hermes-chat";
import { useDirectHermesChat } from "../hooks/useDirectHermesChat";
import { Markdown } from "./Markdown";
import { DirectHermesInteractionCard } from "./DirectHermesInteractionCard";
import { DirectHermesComposer } from "./DirectHermesComposer";
import { DirectHermesAttachmentPreview } from "./DirectHermesAttachmentPreview";

const button = "cursor-pointer rounded-md border border-border bg-raised px-3 py-2 text-[0.786rem] text-text-secondary hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50";

export interface DirectHermesSessionsViewProps {
  botId: string;
  botName: string;
  conversationId: string;
  token: string | null;
}

export function DirectHermesSessionsView({ botId, botName, conversationId, token }: DirectHermesSessionsViewProps) {
  const { chat, state } = useDirectHermesChat(botId, conversationId, token);
  const active = state.active;
  const connected = state.connection === "open";
  useEffect(() => { if (connected && !chat.getSnapshot().commands) void chat.refreshCommands(); }, [chat, connected]);
  const scroll = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    if (scroll.current && pinned.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [state]);
  const rows = [...state.sessions.map(saved => ({
    key: saved.id,
    title: saved.title || "Untitled Hermes session",
    preview: saved.preview,
    opened: state.opened.find(item => item.key === saved.id || item.storedId === saved.id || item.storedId === saved.resolvedId),
  })), ...state.opened.filter(item => !state.sessions.some(saved => saved.id === item.key || saved.id === item.storedId || saved.resolvedId === item.storedId)).map(item => ({
    key: item.key,
    title: item.title || item.entries.find(entry => entry.role === "user")?.text.slice(0, 70) || "New session",
    preview: "",
    opened: item,
  }))];

  return <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-base">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
      <div><h1 className="font-semibold text-text">{botName} · Direct Hermes</h1><p className="text-[0.786rem] text-text-dimmed">Sessions are shared with anyone granted access to this Hermes gateway.</p></div>
      <div className="flex items-center gap-2"><span role="status" className="text-[0.786rem] text-text-muted">{connected ? "Connected" : state.connection === "connecting" ? "Connecting…" : "Disconnected"}</span>
        {!connected && <button className={button} disabled={!token || state.connection === "connecting"} onClick={() => void chat.connect()}>Reconnect</button>}
      </div>
    </header>
    {!token && <p role="alert" className="p-4 text-error-bright">Sign in to connect to Hermes.</p>}
    {state.error && <p role="alert" className="border-b border-error-msg-border bg-error-msg-bg p-3 text-error-bright">{state.error}</p>}
    <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
      <aside aria-label="Sessions" className="flex max-h-48 shrink-0 flex-col border-b border-border bg-surface md:max-h-none md:w-64 md:border-r md:border-b-0">
        <div className="flex items-center justify-between gap-2 px-3 py-2"><h2 className="text-sm font-semibold text-text">Sessions</h2><button className={`${button} relative shrink-0`} aria-label={state.listing ? "Refreshing sessions" : "Refresh"} aria-busy={state.listing} disabled={!connected || state.listing} onClick={() => void chat.refreshSessions()}><span className={state.listing ? "invisible" : ""}>Refresh</span>{state.listing && <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center">…</span>}<span role="status" className="sr-only">{state.listing ? "Refreshing sessions" : ""}</span></button></div>
        <button className={`${button} mx-3 mb-2`} disabled={!connected} onClick={() => { pinned.current = true; void chat.newSession(); }}>New session</button>
        <div className="min-h-0 overflow-y-auto px-2 pb-2">
          {state.listing && !rows.length && <p className="p-2 text-xs text-text-muted">Loading sessions…</p>}
          {!state.listing && !rows.length && <p className="p-2 text-xs text-text-muted">No saved sessions yet.</p>}
          {rows.map(row => <button key={row.key} type="button" aria-pressed={!!row.opened && row.opened.key === active?.key} disabled={!connected && !row.opened} onClick={() => { pinned.current = true; void chat.selectSession(row.opened?.key || row.key); }} className={`mb-1 block w-full cursor-pointer rounded-md px-3 py-2 text-left hover:bg-hover ${!!row.opened && row.opened.key === active?.key ? "bg-hover" : ""}`}>
            <span className="block truncate text-sm font-medium text-text">{row.title}</span>
            {row.preview && <span className="block truncate text-xs text-text-dimmed">{row.preview}</span>}
            {row.opened && <span className="text-xs text-text-muted">{sessionStatus(row.opened)}</span>}
          </button>)}
          {state.sessions.length === 200 && <p className="p-2 text-xs text-text-dimmed">Showing the 200 most recent saved sessions.</p>}
        </div>
      </aside>
      <section aria-label="Hermes chat" className="flex min-h-0 min-w-0 flex-1 flex-col">
        {active ? <>
          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2"><div className="min-w-0"><p className="truncate text-xs text-text-dimmed" title={active.storedId}>{active.storedId || "Creating session…"}</p><p role="status" className="text-sm text-text-muted">{sessionStatus(active)}</p></div><button className={button} disabled={!connected || active.phase === "loading"} onClick={() => void chat.syncSession()}>Sync session</button></div>
          {active.error && <p role="alert" className="bg-error-msg-bg p-3 text-error-bright">{active.error}</p>}
          {active.phase === "uncertain" && <p className="px-4 py-2 text-sm text-text-muted">The turn’s outcome is unknown. Sync or reconnect before sending again. Prompts are never automatically resent.</p>}
          <div ref={scroll} onScroll={() => { const el = scroll.current; if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {active.entries.length === 0 && <p className="text-sm text-text-muted">{active.phase === "loading" ? "Loading Hermes history…" : "Send a message to start this session."}</p>}
            <div className="mx-auto max-w-4xl space-y-4">
              {active.entries.map(entry => entry.tool ? <details key={entry.id} className="rounded-lg border border-border bg-surface">
                <summary className="cursor-pointer px-3 py-2 text-sm text-text-secondary"><span className="font-medium">{entry.tool.name}</span><span className="ml-2 text-xs text-text-dimmed">{entry.tool.status === "complete" ? "Finished" : entry.tool.status === "unknown" ? "Outcome unknown" : "Running…"}</span><span className="ml-2 break-all text-xs">{entry.tool.context}</span></summary>
                <div className="space-y-2 border-t border-border p-3 text-xs text-text-muted">
                  {entry.tool.args !== undefined && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">{formatValue(entry.tool.args)}</pre>}
                  {entry.tool.progress && <p>{entry.tool.progress}</p>}
                  {entry.tool.result !== undefined ? <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all">{formatValue(entry.tool.result)}</pre> : entry.tool.status === "complete" ? <p>Output unavailable in saved history.</p> : null}
                </div>
              </details> : <article key={entry.id} className={`min-w-0 rounded-lg px-3 py-2 ${entry.role === "user" ? "border border-border bg-raised" : ""}`}>
                <p className="mb-1 text-xs font-medium text-text-dimmed">{entry.role === "user" ? "You" : entry.role === "assistant" ? "Hermes" : "System"}</p>
                <div className="break-words text-sm text-text">{entry.role === "user" ? <p className="whitespace-pre-wrap">{entry.text}</p> : <Markdown content={entry.text} />}</div>
                {!!entry.attachments?.length && <ul aria-label="Message attachments" className="mt-2 flex flex-wrap gap-2 text-xs text-text-secondary">{entry.attachments.map(attachment => <li key={attachment.id} className="min-w-0 rounded-md border border-border p-2"><DirectHermesAttachmentPreview attachment={attachment} /><span className="break-all">{attachment.name}</span><span className="ml-2 text-text-dimmed">{attachment.size} bytes</span></li>)}</ul>}
              </article>)}
            </div>
          </div>
          {active.interactions[0] && <DirectHermesInteractionCard key={`${active.key}:${active.interactions[0].requestId}`} interaction={active.interactions[0]} connected={connected} respond={(id, answer) => chat.respond(id, answer)} />}
          <DirectHermesComposer chat={chat} active={active} connected={connected} commands={state.commands} />
        </> : <div className="flex flex-1 items-center justify-center p-6 text-center text-text-muted">Select a saved Hermes session or create a new session.</div>}
      </section>
    </div>
  </div>;
}

function sessionStatus(session: DirectHermesChatSession) {
  if (session.interactions.length) return "Waiting for your response";
  return { idle: session.status || "Ready", loading: "Loading…", sending: "Sending…", running: "Working…", stopping: "Stopping…", uncertain: "Needs sync" }[session.phase];
}
function formatValue(value: unknown) { return typeof value === "string" ? value : JSON.stringify(value, null, 2); }
