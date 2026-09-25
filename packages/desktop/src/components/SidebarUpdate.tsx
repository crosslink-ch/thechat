import { Download } from "lucide-react";
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
      className="mb-2 flex w-full cursor-pointer items-center gap-2.5 rounded-lg border border-border-accent bg-accent/10 px-3 py-2 text-left font-[inherit] text-text transition-colors duration-150 hover:not-disabled:bg-accent/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default"
    >
      <Download size={16} className="shrink-0 text-accent" aria-hidden="true" />
      <span className="min-w-0">
        <span className="block text-[0.929rem] font-medium">{label}</span>
        <span className="block break-words text-[0.857rem] text-text-muted">{detail}</span>
      </span>
    </button>
  );
}
