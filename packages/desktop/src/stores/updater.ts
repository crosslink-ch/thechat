import { create } from "zustand";
import type { Update } from "@tauri-apps/plugin-updater";
import { checkForUpdates, disposeUpdate, downloadUpdate, installAndRelaunch } from "../lib/updater";
import { error as logError, formatError } from "../log";

interface UpdaterStore {
  update: Update | null;
  checking: boolean;
  downloading: boolean;
  downloaded: boolean;
  progress: number | null;
  error: string | null;
  statusMessage: string | null;
  checkForUpdates: () => Promise<void>;
  restartToUpdate: () => Promise<void>;
  clearStatusMessage: () => void;
  reset: () => Promise<void>;
}

function startBackgroundDownload(update: Update) {
  const { downloading, downloaded } = useUpdaterStore.getState();
  if (downloading || downloaded) return;

  let totalDownloaded = 0;
  let contentLength: number | null = null;

  useUpdaterStore.setState({ downloading: true, error: null, progress: 0 });

  downloadUpdate(update, (event) => {
    switch (event.event) {
      case "Started":
        totalDownloaded = 0;
        contentLength = event.data.contentLength ?? null;
        useUpdaterStore.setState({ progress: contentLength === 0 ? null : 0 });
        break;
      case "Progress":
        totalDownloaded += event.data.chunkLength;
        useUpdaterStore.setState({
          progress: contentLength && contentLength > 0
            ? Math.min(100, Math.round((totalDownloaded / contentLength) * 100))
            : null,
        });
        break;
      case "Finished":
        useUpdaterStore.setState({ progress: 100 });
        break;
    }
  }).then(() => {
    useUpdaterStore.setState({ downloading: false, downloaded: true });
  }).catch((error) => {
    logError(`[updater] Background download failed: ${formatError(error)}`);
    useUpdaterStore.setState({
      error: "Failed to download update",
      downloading: false,
      progress: null,
    });
  });
}

export const useUpdaterStore = create<UpdaterStore>()((set, get) => ({
  update: null,
  checking: false,
  downloading: false,
  downloaded: false,
  progress: null,
  error: null,
  statusMessage: null,

  checkForUpdates: async () => {
    if (get().checking) return;

    set({ checking: true, error: null, statusMessage: null });
    const previousUpdate = get().update;

    try {
      const update = await checkForUpdates();
      await disposeUpdate(previousUpdate);

      set({
        update,
        downloading: false,
        downloaded: false,
        progress: null,
        error: null,
        statusMessage: update ? null : "You're on the latest version",
      });

      // Auto-download in background
      if (update) {
        startBackgroundDownload(update);
      }
    } catch (error) {
      logError(`[updater] Unexpected updater store check failure: ${formatError(error)}`);
      set({ error: "Failed to check for updates", statusMessage: null });
    } finally {
      set({ checking: false });
    }
  },

  restartToUpdate: async () => {
    const update = get().update;
    if (!update || !get().downloaded) return;

    try {
      await installAndRelaunch(update);
    } catch (error) {
      logError(`[updater] Failed to install and restart: ${formatError(error)}`);
      set({ error: "Failed to install update" });
    }
  },

  clearStatusMessage: () => {
    set({ statusMessage: null });
  },

  reset: async () => {
    await disposeUpdate(get().update);
    set({
      update: null,
      checking: false,
      downloading: false,
      downloaded: false,
      progress: null,
      error: null,
      statusMessage: null,
    });
  },
}));
