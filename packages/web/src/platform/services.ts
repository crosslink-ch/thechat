import type { PlatformServices } from "@thechat/client/platform/contracts";
import { preferences } from "./preferences";
import { announceSessionChange } from "./browser-session";
export const services: PlatformServices = {
  credentials: null,
  preferences,
  announceSessionChange,
  async log() { /* The shared logger already writes browser diagnostics. */ },
  notifications: {
    async permitDelivery() {
      // Permission requests must originate from the Settings user gesture.
      return typeof Notification !== "undefined" && Notification.permission === "granted";
    },
    send(title, body) { new Notification(title, { body }); },
  },
  localConversations: null,
  nativeFiles: null,
};
