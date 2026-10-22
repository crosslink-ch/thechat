import type { PlatformServices } from "@thechat/client/platform/contracts";
import { preferences } from "./preferences";
import { announceSessionChange } from "./browser-session";
import { pushDeliveryActive } from "./push";

const ICON = "/icons/icon-192.png";

export const services: PlatformServices = {
  credentials: null,
  preferences,
  announceSessionChange,
  async log() { /* The shared logger already writes browser diagnostics. */ },
  notifications: {
    async permitDelivery() {
      // Permission requests must originate from a Settings or prompt user gesture.
      return typeof Notification !== "undefined" && Notification.permission === "granted";
    },
    async send(title, body) {
      // Mobile browsers reject `new Notification()` even with permission; the
      // service worker can always show one.
      const registration = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
      if (registration) {
        await registration.showNotification(title, { body, icon: ICON });
        return;
      }
      new Notification(title, { body, icon: ICON });
    },
    backgroundPushActive: pushDeliveryActive,
  },
  localConversations: null,
  nativeFiles: null,
};
