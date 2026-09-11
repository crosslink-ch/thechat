import { invoke } from "@tauri-apps/api/core";
import * as nativeLog from "@tauri-apps/plugin-log";
import type { PlatformServices } from "@thechat/client/platform/contracts";
export const services: PlatformServices = {
  ...(typeof navigator !== "undefined" && navigator.platform?.toLowerCase().includes("win") ? {
    microphone: {
      getPermissionState: () => invoke<"prompt" | "granted" | "denied">("plugin:microphone|get_permission_state"),
      prepareRecording: () => invoke<void>("plugin:microphone|prepare_recording"),
      cancelRecording: () => invoke<void>("plugin:microphone|cancel_recording"),
      openSettings: () => invoke<void>("plugin:microphone|open_settings"),
    },
  } : {}),
  credentials: {
    get: key => invoke("kv_get", { key }),
    set: (key, value) => invoke("kv_set", { key, value }),
    delete: key => invoke("kv_delete", { key }),
  },
  preferences: {
    get: key => invoke("kv_get", { key }),
    set: (key, value) => invoke("kv_set", { key, value }),
    delete: key => invoke("kv_delete", { key }),
  },
  announceSessionChange() {},
  log: (level, message) => nativeLog[level](message),
  notifications: {
    async permitDelivery() {
      const plugin = await import("@tauri-apps/plugin-notification");
      return await plugin.isPermissionGranted() || await plugin.requestPermission() === "granted";
    },
    async send(title, body) {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      sendNotification({ title, body });
    },
  },
  localConversations: { list: () => invoke("list_conversations") },
  nativeFiles: {
    available: () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window,
    async listen(handlers) {
      return (await import("../lib/native-file-drop")).listenForNativeFileDrops(handlers);
    },
    download: (url, suggestedFileName) => invoke("download_attachment_to_file", { url, suggestedFileName }),
  },
};
