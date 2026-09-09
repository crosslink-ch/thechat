import { isWeb } from "./environment";
import { useAuthStore } from "../stores/auth";
import { expireBrowserSession } from "../lib/session-boundary";

const SIGNAL = "thechat:session-changed";
let channel: BroadcastChannel | null = null;
/** The payload is a random change signal, never identity, cookie or token. */
export function announceSessionChange() {
  if (!isWeb) return;
  const signal = crypto.randomUUID();
  try { localStorage.setItem(SIGNAL, signal); } catch { /* privacy mode */ }
  try {
    if (channel) channel.postMessage(signal);
    else if (typeof BroadcastChannel !== "undefined") {
      const sender = new BroadcastChannel(SIGNAL); sender.postMessage(signal); sender.close();
    }
  } catch { /* storage/visibility revalidation remains available */ }
}
export function startBrowserSessionSync() {
  let lastSignal: string | null = null;
  const changed = (signal: unknown) => {
    if (typeof signal !== "string" || signal === lastSignal) return;
    lastSignal = signal;
    expireBrowserSession();
    useAuthStore.setState({ loading: true });
    void useAuthStore.getState().initialize();
  };
  const storage = (event: StorageEvent) => { if (event.key === SIGNAL) changed(event.newValue); };
  const visible = () => {
    if (document.visibilityState === "visible") void useAuthStore.getState().initialize();
  };
  try {
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(SIGNAL);
      channel.onmessage = event => changed(event.data);
    }
  } catch { /* storage fallback */ }
  window.addEventListener("storage", storage);
  document.addEventListener("visibilitychange", visible);
  return () => {
    channel?.close(); channel = null;
    window.removeEventListener("storage", storage);
    document.removeEventListener("visibilitychange", visible);
  };
}
