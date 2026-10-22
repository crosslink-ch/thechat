import { startBrowserSessionSync } from "./browser-session";
import { useEffect } from "react";
import { useAuthStore } from "@thechat/client/stores/auth";
import { useActivityStore } from "@thechat/client/stores/activity";
import { useFontSizeStore } from "@thechat/client/stores/font-size";
import { OPEN_CONVERSATION_MESSAGE, appHash } from "../sw/service-worker";
import { registerServiceWorker, syncPushState } from "./push";
import { PushPrompt } from "./PushPrompt";

/** A tapped notification asks an already-open window to switch conversation. */
function listenForNotificationTaps() {
  const container = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
  if (!container) return () => undefined;
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: unknown; hash?: unknown } | null;
    if (data?.type !== OPEN_CONVERSATION_MESSAGE) return;
    window.location.hash = appHash(data.hash);
  };
  container.addEventListener("message", onMessage);
  container.startMessages?.();
  return () => container.removeEventListener("message", onMessage);
}

/** Keep the Home Screen icon badge in step with unread messages. */
function syncAppBadge() {
  const nav = navigator as Navigator & {
    setAppBadge?: (count?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  if (!nav.setAppBadge) return () => undefined;
  const apply = (count: number) => {
    const update = count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.();
    void update?.catch(() => undefined);
  };
  apply(useActivityStore.getState().totalUnreadMessages);
  return useActivityStore.subscribe((state, previous) => {
    if (state.totalUnreadMessages !== previous.totalUnreadMessages) apply(state.totalUnreadMessages);
  });
}

export function usePlatformLifecycle(_token: string | null) {
  const userId = useAuthStore((state) => state.user?.id ?? null);

  useEffect(() => {
    const stop = startBrowserSessionSync();
    void useAuthStore.getState().initialize();
    void useFontSizeStore.getState().initialize();
    // Registered for everyone: page notifications on phones need it too.
    void registerServiceWorker();
    const stopTaps = listenForNotificationTaps();
    const stopBadge = syncAppBadge();
    return () => {
      stop();
      stopTaps();
      stopBadge();
    };
  }, []);

  useEffect(() => {
    void syncPushState(userId);
    if (!userId) return;
    // Permission can change in system settings while the app is in the background.
    const onVisible = () => {
      if (document.visibilityState === "visible") void syncPushState(userId);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [userId]);
}
export function PlatformDialogs() { return <PushPrompt />; }
export function PlatformTitlebar() { return null; }
export function PlatformUpdateToast() { return null; }
export function PlatformSidebarUpdate() { return null; }

export { BrowserNotificationSettings as PlatformNotificationSettings } from "./BrowserNotificationSettings";
