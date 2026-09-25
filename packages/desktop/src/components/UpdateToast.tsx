import { RotateCw } from "lucide-react";
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
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex max-w-[420px] animate-slide-up flex-col gap-3 rounded-xl border border-border bg-surface/95 p-4 shadow-card backdrop-blur-2xl backdrop-saturate-150">
      <div className="min-w-0">
        <div className="text-[0.929rem] font-semibold text-text">
          {error ? "Update failed" : `Update ready: ${update.version}`}
        </div>
        {!error && (
          <div className="mt-0.5 text-[0.929rem] text-text-muted">
            Restart the app to apply the update.
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-error-msg-border bg-error-msg-bg px-3 py-2 text-[0.857rem] text-error-bright">
          {error}
        </div>
      )}

      {downloaded && (
        <div className="flex items-center justify-end">
          <button
            type="button"
            disabled={installing}
            aria-busy={installing}
            className="pointer-events-auto inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent bg-accent-fill px-3 font-[inherit] text-[0.929rem] font-medium text-white transition-colors duration-150 hover:not-disabled:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-45"
            onClick={() => {
              void restartToUpdate();
            }}
          >
            <RotateCw size={14} aria-hidden="true" />
            {installing ? "Installing update…" : "Restart to update"}
          </button>
        </div>
      )}
    </div>
  );
}
