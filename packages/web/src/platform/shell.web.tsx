import { startBrowserSessionSync } from "./browser-session";
import { useEffect } from "react";
import { useAuthStore } from "@thechat/client/stores/auth";
import { useFontSizeStore } from "@thechat/client/stores/font-size";
export function usePlatformLifecycle(_token: string | null) {
  useEffect(() => {
    const stop = startBrowserSessionSync();
    void useAuthStore.getState().initialize();
    void useFontSizeStore.getState().initialize();
    return stop;
  }, []);
}
export function PlatformDialogs() { return null; }
export function PlatformTitlebar() { return null; }
export function PlatformUpdateToast() { return null; }

export { BrowserNotificationSettings as PlatformNotificationSettings } from "./BrowserNotificationSettings";
