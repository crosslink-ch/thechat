import { useUpdaterStore } from "../stores/updater";

/** Persistent update entry point, outside the sidebar's scrolling content. */
export function SidebarUpdate() {
  const update = useUpdaterStore((s) => s.update);
  const checking = useUpdaterStore((s) => s.checking);
  const downloading = useUpdaterStore((s) => s.downloading);
  const downloaded = useUpdaterStore((s) => s.downloaded);
  const installing = useUpdaterStore((s) => s.installing);
  const progress = useUpdaterStore((s) => s.progress);
  const error = useUpdaterStore((s) => s.error);
  const restartToUpdate = useUpdaterStore((s) => s.restartToUpdate);
  const retryDownload = useUpdaterStore((s) => s.retryDownload);

  if (!update) return null;

  const busy = checking || downloading || installing;
  const label = installing ? "Installing update…"
    : downloading ? "Downloading update"
    : error ? "Retry update" : "Update available";
  const detail = installing ? "The app will restart shortly"
    : downloading ? progress === null ? "Preparing your update…" : `${progress}% downloaded`
    : error ? `${error}. Click to retry.`
    : `v${update.version} · ${downloaded ? "Restart to install" : "Download update"}`;

  return (
    <button
      type="button"
      disabled={busy}
      aria-busy={busy}
      title={`Update to v${update.version}`}
      onClick={() => void (downloaded ? restartToUpdate() : retryDownload())}
      className="mb-2 flex w-full cursor-pointer items-center gap-2.5 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-left font-[inherit] text-text transition-colors duration-150 hover:bg-accent/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default"
    >
      <svg className="shrink-0 text-accent" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4" />
      </svg>
      <span className="min-w-0">
        <span className="block text-[0.857rem] font-semibold">{label}</span>
        <span className="block break-words text-[0.786rem] text-text-muted">{detail}</span>
      </span>
    </button>
  );
}
