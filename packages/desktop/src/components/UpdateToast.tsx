import { useMemo } from "react";
import { useUpdaterStore } from "../stores/updater";

export function UpdateToast() {
  const update = useUpdaterStore((s) => s.update);
  const installing = useUpdaterStore((s) => s.installing);
  const progress = useUpdaterStore((s) => s.progress);
  const error = useUpdaterStore((s) => s.error);
  const dismissedVersion = useUpdaterStore((s) => s.dismissedVersion);
  const installAvailableUpdate = useUpdaterStore((s) => s.installAvailableUpdate);
  const dismissUpdateToast = useUpdaterStore((s) => s.dismissUpdateToast);

  const visible = !!update && dismissedVersion !== update.version;

  const releaseNotes = useMemo(() => {
    const body = update?.body?.trim();
    if (!body) return null;
    return body.length > 180 ? `${body.slice(0, 177)}...` : body;
  }, [update]);

  if (!visible) return null;

  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex max-w-[420px] animate-slide-up flex-col gap-3 rounded-xl border border-border-strong bg-surface p-4 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-text">
            Update available: {update.version}
          </div>
          <div className="mt-1 text-[12px] text-text-muted">
            Current version: {update.currentVersion}
          </div>
        </div>
        {!installing && (
          <button
            type="button"
            aria-label="Dismiss update notification"
            className="pointer-events-auto flex size-7 cursor-pointer items-center justify-center rounded-md border-none bg-transparent text-text-muted transition-colors duration-150 hover:bg-hover hover:text-text"
            onClick={dismissUpdateToast}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 3L11 11" />
              <path d="M11 3L3 11" />
            </svg>
          </button>
        )}
      </div>

      {releaseNotes && (
        <div className="rounded-lg border border-border bg-raised px-3 py-2 text-[12px] text-text-secondary">
          {releaseNotes}
        </div>
      )}

      {installing && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-[12px] text-text-muted">
            <span>Downloading update...</span>
            <span>{progress == null ? "Preparing" : `${progress}%`}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-raised">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-200"
              style={{ width: progress == null ? "35%" : `${progress}%` }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-error-border bg-error-bg px-3 py-2 text-[12px] text-error-light">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        {!installing && (
          <button
            type="button"
            className="pointer-events-auto cursor-pointer rounded-lg border-none bg-button px-3.5 py-1.5 text-[12px] font-medium text-text-secondary transition-colors duration-150 hover:not-disabled:bg-button-hover disabled:cursor-not-allowed disabled:opacity-50"
            onClick={dismissUpdateToast}
          >
            Later
          </button>
        )}
        <button
          type="button"
          className="pointer-events-auto cursor-pointer rounded-lg border-none bg-accent px-3.5 py-1.5 text-[12px] font-medium text-white transition-colors duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => {
            void installAvailableUpdate();
          }}
          disabled={installing}
        >
          {installing ? "Installing..." : "Update now"}
        </button>
      </div>
    </div>
  );
}
