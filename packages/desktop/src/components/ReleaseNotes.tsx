import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Markdown } from "./Markdown";
import { releaseNotesSeen } from "../lib/release-notes-state";
import { requestInputBarFocus } from "../stores/input-focus";
import { closeReleaseNotes, useReleaseNotesStore, type ReleaseNotesPreview } from "../stores/release-notes";

import { releaseNotesCatalog, shippedReleaseVersion, type ReleaseNote } from "../lib/release-notes";

interface ReleaseNotesHostProps {
  userId: string | null;
  autoShow?: boolean;
  version?: string;
  catalog?: readonly ReleaseNote[];
  seen?: typeof releaseNotesSeen;
}

/** Kept at the app root, not the route, so navigating cannot reopen a release. */
export function ReleaseNotesHost({ userId, autoShow = true, version = shippedReleaseVersion, catalog = releaseNotesCatalog, seen = releaseNotesSeen }: ReleaseNotesHostProps) {
  const request = useReleaseNotesStore((state) => state.request);
  const [automatic, setAutomatic] = useState<{ userId: string; version: string } | null>(null);
  const eligible = autoShow && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
    && catalog.some((entry) => entry.version === version && entry.body.trim());
  useEffect(() => {
    setAutomatic(userId && eligible && !seen.isAutomaticDisabled(userId) && !seen.hasSeen(userId, version) ? { userId, version } : null);
  }, [userId, version, eligible, seen]);
  // Reject stale identity/version state before the effect runs on logout/switch.
  const active = autoShow && automatic?.userId === userId && automatic?.version === version ? automatic : null;
  if (!request && !active) return null;
  const preview = request?.kind === "preview" ? request.preview : undefined;
  const close = () => {
    if (request) {
      if (userId && seen.isAutomaticDisabled(userId)) setAutomatic(null);
      closeReleaseNotes();
      return;
    }
    if (active) seen.dismiss(active.userId, active.version);
    setAutomatic(null);
  };
  return <ReleaseNotesDialog
    key={request ? `${request.kind}:${userId}:${preview?.version ?? version}` : `automatic:${userId}:${version}`}
    version={preview?.version ?? version}
    catalog={catalog}
    userId={userId}
    seen={seen}
    preview={preview}
    onClose={close}
  />;
}

function ReleaseNotesDialog({ version, catalog, userId, seen, preview, onClose }: {
  version: string;
  catalog: readonly ReleaseNote[];
  userId: string | null;
  seen: typeof releaseNotesSeen;
  preview?: ReleaseNotesPreview;
  onClose: () => void;
}) {
  const [selectedVersion, setSelectedVersion] = useState(version);
  const [automaticDisabled, setAutomaticDisabled] = useState(() => userId ? seen.isAutomaticDisabled(userId) : false);
  const [returnFocus] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const note = preview ? undefined : catalog.find((entry) => entry.version === selectedVersion);
  const body = preview ? preview.body : note?.body;
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // A pending installed notice may replace an update preview. Do not
            // move focus out of that dialog. Palette items have already unmounted.
            if (document.querySelector('[role="dialog"]')) return;
            if (returnFocus?.isConnected) returnFocus.focus();
            else requestInputBarFocus();
          }}
          className="app-dialog fixed left-1/2 top-1/2 z-50 flex max-h-[85dvh] w-[calc(100%-2rem)] max-w-[680px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border-strong bg-surface shadow-card">
          <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border p-5">
            <div className="min-w-0 [overflow-wrap:anywhere]">
              <Dialog.Title className="text-lg font-semibold text-text">{preview ? "Update release notes" : "What's new"}</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-text-muted">
                {preview ? `Preview of TheChat ${version}. This update is not installed yet.` : `Running TheChat ${version}. Browse bundled release history below.`}
              </Dialog.Description>
            </div>
            <Dialog.Close className="shrink-0 rounded-lg border border-border px-3 py-2 text-sm text-text-muted hover:bg-elevated">Close</Dialog.Close>
          </header>
          {!preview && <div className="shrink-0 border-b border-border px-5 py-3">
            <label className="flex min-w-0 flex-col gap-1.5 text-sm text-text-muted">
              Release history
              <span className="relative block min-w-0">
                <select className="w-full min-w-0 appearance-none rounded-lg border border-border bg-base py-2 pr-8 pl-3 text-text" value={selectedVersion} onChange={(event) => setSelectedVersion(event.target.value)}>
                  {!catalog.some((entry) => entry.version === version) && <option value={version}>{version} — notes unavailable</option>}
                  {catalog.map((entry) => <option key={entry.version} value={entry.version}>{entry.version} — {entry.title}</option>)}
                </select>
                <span aria-hidden="true" className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs">▾</span>
              </span>
            </label>
          </div>}
          <div key={selectedVersion} data-testid="release-notes-scroll" className="min-h-0 overflow-y-auto overscroll-contain p-5 [overflow-wrap:anywhere]">
            {body?.trim() ? <article>
              {note && <div className="mb-4"><h2 className="text-lg font-semibold text-text">{note.title}</h2><time className="text-sm text-text-muted" dateTime={note.date}>{note.date}</time></div>}
              <Markdown content={body} />
            </article> : <p className="text-sm text-text-muted">Release notes are not available for this version.</p>}
          </div>
          {userId && <footer className="shrink-0 border-t border-border p-5">
            <label className="flex cursor-pointer items-start gap-2.5 text-sm text-text">
              <input
                type="checkbox"
                className="mt-0.5 size-4 shrink-0 accent-accent"
                checked={automaticDisabled}
                onChange={(event) => {
                  const disabled = event.target.checked;
                  seen.setAutomaticDisabled(userId, disabled);
                  setAutomaticDisabled(disabled);
                }}
              />
              <span>Don't show release notes automatically</span>
            </label>
            <p className="mt-2 text-xs leading-relaxed text-text-muted">
              Applies to your account on this browser or device. You can always open What's new from Settings and change this preference here.
            </p>
          </footer>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
