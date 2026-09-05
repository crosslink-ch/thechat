import { useEffect, useMemo, useRef, useState } from "react";
import { DIRECT_HERMES_ATTACHMENT_MAX_BYTES, DIRECT_HERMES_ATTACHMENT_MAX_COUNT, type DirectHermesChat, type DirectHermesChatSession } from "../lib/direct-hermes-chat";
import { open } from "@tauri-apps/plugin-dialog";
import { fileFromNativeDrop, isTauriRuntime } from "../lib/native-file-drop";
import { DirectHermesAttachmentPreview } from "./DirectHermesAttachmentPreview";

const button = "cursor-pointer rounded-md border border-border bg-raised px-3 py-2 text-[0.786rem] text-text-secondary hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50";
let nextComposerId = 0;

interface Props {
  chat: DirectHermesChat;
  active: DirectHermesChatSession;
  connected: boolean;
  commands?: { name: string; description: string }[];
}

/** Reset DOM and pending callbacks on both controller and session changes. */
export function DirectHermesComposer(props: Props) {
  const identity = useMemo(() => ++nextComposerId, [props.chat]);
  return <SessionComposer key={`${identity}:${props.active.key}`} {...props} />;
}

function SessionComposer({ chat, active, connected, commands = [] }: Props) {
  const picker = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(false);
  const [error, setError] = useState<string>();
  const [choosing, setChoosing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const choosingRef = useRef(false);
  const commandQuery = active.draft.trimStart();
  const suggestions = /^\/\S*$/.test(commandQuery) ? commands.filter(command => command.name.startsWith(commandQuery)).slice(0, 8) : [];
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const isCurrent = () => mounted.current && chat.getSnapshot().active?.key === active.key;
  const canAttach = () => isCurrent() && chat.getSnapshot().connection === "open" && active.phase === "idle" && !active.submitting;
  const attachmentDisabled = !connected || active.phase !== "idle" || !!active.submitting || choosing;
  const send = () => { if (isCurrent() && !choosingRef.current && chat.canSend()) void chat.send(); };
  const addFiles = async (files: File[]) => {
    if (!files.length || !canAttach()) return;
    setError(undefined);
    try { await chat.addAttachments(files); }
    catch { if (isCurrent()) setError("Could not add attachments. Try choosing the files again."); }
  };
  const chooseFiles = async () => {
    if (!canAttach() || choosingRef.current) return;
    if (!isTauriRuntime()) { picker.current?.click(); return; }
    choosingRef.current = true; setChoosing(true); setError(undefined);
    try {
      const selected = await open({ multiple: true, directory: false, title: "Attach files to Hermes" });
      if (!selected || !canAttach()) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      if (paths.length + (active.attachments?.length ?? 0) > DIRECT_HERMES_ATTACHMENT_MAX_COUNT) { setError("A message can contain at most 5 files."); return; }
      const files: File[] = [];
      // Existing vetted native reader returns bytes, never gateway-local paths.
      // Read sequentially and abandon stale dialog/read results on navigation.
      for (const path of paths) {
        if (!canAttach()) return;
        const file = await fileFromNativeDrop(path);
        if (!canAttach()) return;
        if (file.size > DIRECT_HERMES_ATTACHMENT_MAX_BYTES) { setError("Attachments must be 2 MiB or smaller per file."); return; }
        files.push(file);
      }
      await addFiles(files);
    } catch {
      if (isCurrent()) setError("Could not read the selected files. Choose files up to 2 MiB each and try again.");
    } finally {
      choosingRef.current = false;
      if (isCurrent()) setChoosing(false);
    }
  };

  return <form aria-label="Hermes composer" onSubmit={event => { event.preventDefault(); send(); }}
    onPaste={event => {
      if (!canAttach() || choosingRef.current) return;
      const files = Array.from(event.clipboardData.items).filter(item => item.kind === "file" && item.type.startsWith("image/")).map(item => item.getAsFile()).filter((file): file is File => !!file);
      if (!files.length) return;
      // Mixed text/image clipboard content must retain its ordinary text paste.
      if (!event.clipboardData.getData("text/plain")) event.preventDefault();
      event.stopPropagation();
      void addFiles(files);
    }}
    onDragOver={event => { if (canAttach() && !choosingRef.current && Array.from(event.dataTransfer.types).includes("Files")) { event.preventDefault(); event.stopPropagation(); setDragging(true); } }}
    onDragLeave={() => setDragging(false)}
    onDrop={event => {
      setDragging(false);
      if (!canAttach() || choosingRef.current || !event.dataTransfer.files.length) return;
      event.preventDefault(); event.stopPropagation();
      void addFiles(Array.from(event.dataTransfer.files));
    }}
    className={`relative border-t border-border p-3 ${dragging ? "bg-hover outline outline-1 outline-text-muted" : ""}`}>
    {suggestions.length > 0 && <div className="absolute right-3 bottom-full left-3 z-10 rounded-lg border border-border bg-surface p-2 shadow-lg">
      <p className="px-2 pb-1 text-xs text-text-dimmed">Gateway command catalog · some commands require the Hermes app</p>
      <ul aria-label="Hermes commands" className="max-h-40 overflow-y-auto">{suggestions.map(command => <li key={command.name}><button type="button" disabled={!connected || active.phase === "loading"} onClick={() => { if (isCurrent()) { chat.setDraft(`${command.name} `); input.current?.focus(); } }} className="w-full cursor-pointer rounded px-2 py-1 text-left text-sm text-text-secondary hover:bg-hover disabled:opacity-50">{command.name} — {command.description}</button></li>)}</ul>
    </div>}
    {(active.attachments ?? []).length > 0 && <ul aria-label="Pending attachments" className="mb-2 flex max-h-36 flex-wrap gap-2 overflow-y-auto">
      {(active.attachments ?? []).map(attachment => <li key={attachment.id} className="min-w-0 max-w-full rounded-md border border-border bg-surface px-3 py-2 text-xs text-text-secondary">
        <DirectHermesAttachmentPreview attachment={attachment} />
        <div className="flex items-center gap-2"><span className="min-w-0 break-all">{attachment.name}</span><span className="shrink-0 text-text-dimmed">{attachment.size} bytes</span><button type="button" aria-label={`Remove ${attachment.name}`} className="cursor-pointer rounded px-1 hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50" disabled={!!active.submitting || attachment.status === "uploading" || attachment.status === "uncertain"} onClick={() => { if (isCurrent()) void chat.removeAttachment(attachment.id); }}>×</button></div>
        <p role={attachment.status === "error" ? "alert" : "status"} className={attachment.status === "error" ? "text-error-bright" : "text-text-dimmed"}>{attachment.error || { queued: "Queued · uploads on Send", uploading: "Uploading…", ready: "Uploaded · ready", error: "Attachment failed", uncertain: "Upload outcome unknown · sync before retrying" }[attachment.status]}</p>
      </li>)}
    </ul>}
    {error && <p role="alert" className="mb-2 text-xs text-error-bright">{error}</p>}
    {choosing && <p role="status" className="mb-2 text-xs text-text-dimmed">Choosing / reading files…</p>}
    <input ref={picker} type="file" multiple aria-label="Choose attachments" className="hidden" disabled={attachmentDisabled} onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; void addFiles(files); }} />
    <textarea ref={input} aria-label="Message Hermes" placeholder="Message Hermes…" rows={3} value={active.draft} disabled={!connected || active.phase === "loading"} onChange={event => { if (isCurrent()) chat.setDraft(event.target.value); }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); send(); } }} className="w-full resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-text-muted disabled:opacity-50" />
    <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><div className="text-xs text-text-dimmed"><p>Enter to send · Shift+Enter for a new line · / for commands</p><p>Up to 5 files · 2 MiB each · uploads only on Send</p>{commandQuery.startsWith("/") && <p>Send to run a Hermes command, not a chat message. Send attachments separately.</p>}</div><div className="flex gap-2">
      <button type="button" className={button} disabled={attachmentDisabled} onClick={() => void chooseFiles()}>Attach files</button>
      {["sending", "running", "stopping", "uncertain"].includes(active.phase) && <button type="button" className={button} disabled={!connected || active.phase === "stopping"} onClick={() => { if (isCurrent()) void chat.stop(); }}>{active.phase === "stopping" ? "Stopping…" : "Stop"}</button>}
      <button type="submit" className={button} disabled={!connected || choosing || !chat.canSend()}>Send</button>
    </div></div>
  </form>;
}
