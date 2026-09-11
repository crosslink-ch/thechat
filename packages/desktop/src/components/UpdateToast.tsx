import { useUpdaterStore } from "../stores/updater";

export function UpdateToast() {
  const update = useUpdaterStore((s) => s.update);
  const installing = useUpdaterStore((s) => s.installing);
  const downloaded = useUpdaterStore((s) => s.downloaded);
  const error = useUpdaterStore((s) => s.error);
  const restartToUpdate = useUpdaterStore((s) => s.restartToUpdate);

  // Only show the toast once the update is downloaded and ready to install
  if (!update || (!downloaded && !error)) return null;

  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex max-w-[420px] animate-slide-up flex-col gap-3 rounded-xl border border-border-strong bg-surface p-4 shadow-card">
      <div className="min-w-0">
        <div className="text-[0.929rem] font-semibold text-text">
          {error ? "Update failed" : `Update ready: ${update.version}`}
        </div>
        {!error && (
          <div className="mt-1 text-[0.857rem] text-text-muted">
            Restart the app to apply the update.
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-error-border bg-error-bg px-3 py-2 text-[0.857rem] text-error-light">
          {error}
        </div>
      )}

      {downloaded && (
        <div className="flex items-center justify-end">
          <button
            type="button"
            disabled={installing}
            aria-busy={installing}
            className="pointer-events-auto cursor-pointer rounded-lg border-none bg-accent px-3.5 py-1.5 text-[0.857rem] font-medium text-white transition-colors duration-150 hover:opacity-90 disabled:cursor-default disabled:opacity-60"
            onClick={() => {
              void restartToUpdate();
            }}
          >
            {installing ? "Installing update…" : "Restart to update"}
          </button>
        </div>
      )}
    </div>
  );
}
