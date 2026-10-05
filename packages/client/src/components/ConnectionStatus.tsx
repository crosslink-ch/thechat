import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";
import { useWebSocketStore } from "../stores/websocket";
import { useWorkspacesStore } from "../stores/workspaces";
import { buttonClass } from "./ui";

export function ConnectionStatus({ authenticated }: { authenticated: boolean }) {
  const [online, setOnline] = useState(() => navigator.onLine);
  const reconnecting = useWebSocketStore((state) => state.reconnecting);
  const error = useWorkspacesStore((state) => state.error);
  const loading = useWorkspacesStore((state) => state.loading);
  useEffect(() => {
    const refresh = () => {
      const workspaces = useWorkspacesStore.getState();
      if (authenticated && navigator.onLine && !workspaces.loading) {
        void workspaces.initialize();
      }
    };
    let wasOnline = navigator.onLine;
    const update = () => {
      const nextOnline = navigator.onLine;
      setOnline(nextOnline);
      if (nextOnline && !wasOnline) refresh();
      wasOnline = nextOnline;
    };
    // Subscribe to transitions, not initial socket setup or React render timing.
    const unsubscribe = useWebSocketStore.subscribe((state, previous) => {
      if (state.connected && !previous.connected && previous.reconnecting) refresh();
    });
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    update();
    return () => {
      unsubscribe();
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, [authenticated]);
  const message = !online
    ? "You're offline. Check your internet connection."
    : authenticated && reconnecting
      ? "Connection lost. Reconnecting to TheChat..."
      : authenticated && error
        ? `${error} Check your connection and retry.`
        : null;
  if (!message) return null;

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="flex min-w-0 shrink-0 items-center gap-2 border-b border-warning/25 bg-warning-bg px-3 py-2 text-[0.857rem] leading-relaxed text-warning-text">
      <WifiOff size={16} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0 flex-1 break-words">{message}</span>
      {authenticated && error && (
        <button type="button" className={`shrink-0 ${buttonClass("secondary", "sm")}`} disabled={!online || loading} onClick={() => void useWorkspacesStore.getState().initialize()}>
          {loading ? "Retrying..." : "Retry"}
        </button>
      )}
    </div>
  );
}
