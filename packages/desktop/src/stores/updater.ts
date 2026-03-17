import { create } from "zustand";
import type { Update } from "@tauri-apps/plugin-updater";
import { checkForUpdates, disposeUpdate, installUpdate } from "../lib/updater";
import { error as logError, formatError } from "../log";

interface UpdaterStore {
  update: Update | null;
  checking: boolean;
  installing: boolean;
  progress: number | null;
  error: string | null;
  statusMessage: string | null;
  dismissedVersion: string | null;
  checkForUpdates: () => Promise<void>;
  installAvailableUpdate: () => Promise<void>;
  dismissUpdateToast: () => void;
  clearStatusMessage: () => void;
  reset: () => Promise<void>;
}

export const useUpdaterStore = create<UpdaterStore>()((set, get) => ({
  update: null,
  checking: false,
  installing: false,
  progress: null,
  error: null,
  statusMessage: null,
  dismissedVersion: null,

  checkForUpdates: async () => {
    if (get().checking) return;

    set({ checking: true, error: null, statusMessage: null });
    const previousUpdate = get().update;

    try {
      const update = await checkForUpdates();
      await disposeUpdate(previousUpdate);

      set((state) => ({
        update,
        progress: null,
        error: null,
        statusMessage: update ? null : "You’re on the latest version",
        dismissedVersion:
          update && state.dismissedVersion !== update.version ? null : state.dismissedVersion,
      }));
    } catch (error) {
      logError(`[updater] Unexpected updater store check failure: ${formatError(error)}`);
      set({ error: "Failed to check for updates", statusMessage: null });
    } finally {
      set({ checking: false });
    }
  },

  installAvailableUpdate: async () => {
    const update = get().update;
    if (!update || get().installing) return;

    let downloaded = 0;
    let contentLength: number | null = null;

    set({ installing: true, error: null, statusMessage: null, progress: 0 });

    try {
      await installUpdate(update, (event) => {
        switch (event.event) {
          case "Started":
            downloaded = 0;
            contentLength = event.data.contentLength ?? null;
            set({ progress: contentLength === 0 ? null : 0 });
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            set({
              progress: contentLength && contentLength > 0
                ? Math.min(100, Math.round((downloaded / contentLength) * 100))
                : null,
            });
            break;
          case "Finished":
            set({ progress: 100 });
            break;
        }
      });
    } catch (error) {
      logError(`[updater] Failed to install available update: ${formatError(error)}`);
      set({
        error: "Failed to install update",
        installing: false,
        progress: null,
      });
      return;
    }
  },

  dismissUpdateToast: () => {
    const update = get().update;
    set({
      dismissedVersion: update?.version ?? get().dismissedVersion,
      error: null,
    });
  },

  clearStatusMessage: () => {
    set({ statusMessage: null });
  },

  reset: async () => {
    await disposeUpdate(get().update);
    set({
      update: null,
      checking: false,
      installing: false,
      progress: null,
      error: null,
      statusMessage: null,
      dismissedVersion: null,
    });
  },
}));
