import { create } from "zustand";
import type { Update } from "@tauri-apps/plugin-updater";
import { checkForUpdates, disposeUpdate, downloadUpdate, installAndRelaunch } from "../lib/updater";
import { error as logError, formatError } from "@thechat/client/log";

interface UpdaterStore {
  update: Update | null;
  checking: boolean;
  downloading: boolean;
  downloaded: boolean;
  installing: boolean;
  progress: number | null;
  error: string | null;
  statusMessage: string | null;
  checkForUpdates: () => Promise<void>;
  retryDownload: () => Promise<void>;
  restartToUpdate: () => Promise<void>;
  clearStatusMessage: () => void;
  reset: () => Promise<void>;
}

// Reset invalidates async work immediately, but native operations must finish
// using their handle before it can be closed.
let generation = 0;
const activeUpdates = new Set<Update>();

async function closeUpdate(update: Update | null) {
  if (!update || activeUpdates.has(update)) return;
  try {
    await disposeUpdate(update);
  } catch (error) {
    logError(`[updater] Failed to dispose update: ${formatError(error)}`);
  }
}

async function startBackgroundDownload(update: Update) {
  const { downloading, downloaded } = useUpdaterStore.getState();
  if (downloading || downloaded) return;

  const startedGeneration = generation;
  const isCurrent = () => startedGeneration === generation && useUpdaterStore.getState().update === update;
  let settled = false;
  let totalDownloaded = 0;
  let contentLength: number | null = null;

  activeUpdates.add(update);
  useUpdaterStore.setState({ downloading: true, error: null, progress: 0 });

  try {
    await downloadUpdate(update, (event) => {
      if (settled || !isCurrent()) return;
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
    });
    if (isCurrent()) useUpdaterStore.setState({ downloading: false, downloaded: true });
  } catch (error) {
    if (isCurrent()) {
      logError(`[updater] Background download failed: ${formatError(error)}`);
      useUpdaterStore.setState({ error: "Failed to download update", downloading: false, progress: null });
    }
  } finally {
    settled = true;
    activeUpdates.delete(update);
    if (!isCurrent()) await closeUpdate(update);
  }
}

export const useUpdaterStore = create<UpdaterStore>()((set, get) => ({
  update: null,
  checking: false,
  downloading: false,
  downloaded: false,
  installing: false,
  progress: null,
  error: null,
  statusMessage: null,

  checkForUpdates: async () => {
    if (get().checking || get().downloading || get().installing) return;

    const startedGeneration = generation;
    const previousUpdate = get().update;
    set({ checking: true, error: null, statusMessage: null });

    try {
      const update = await checkForUpdates();
      if (startedGeneration !== generation) {
        if (update !== get().update) await closeUpdate(update);
        return;
      }
      if (!update) {
        set({ statusMessage: previousUpdate ? null : "You're on the latest version" });
        return;
      }
      if (previousUpdate?.version === update.version) {
        if (update !== previousUpdate) await closeUpdate(update);
        return;
      }

      // Transfer ownership before awaiting disposal, so reset cannot revive a
      // candidate after closing the previous handle.
      set({ update, downloading: false, downloaded: false, progress: null, error: null, statusMessage: null });
      void startBackgroundDownload(update);
      await closeUpdate(previousUpdate);
    } catch (error) {
      if (startedGeneration === generation) {
        logError(`[updater] Unexpected updater store check failure: ${formatError(error)}`);
        set({ error: "Failed to check for updates", statusMessage: null });
      }
    } finally {
      if (startedGeneration === generation) set({ checking: false });
    }
  },

  retryDownload: async () => {
    const { update, checking, downloading, downloaded, installing } = get();
    if (!update || checking || downloading || downloaded || installing) return;
    await startBackgroundDownload(update);
  },

  restartToUpdate: async () => {
    const { update, downloaded, checking, downloading, installing } = get();
    if (!update || !downloaded || checking || downloading || installing) return;

    const startedGeneration = generation;
    const isCurrent = () => startedGeneration === generation && get().update === update;
    activeUpdates.add(update);
    set({ installing: true, error: null });
    try {
      await installAndRelaunch(update);
    } catch (error) {
      if (isCurrent()) {
        logError(`[updater] Failed to install and restart: ${formatError(error)}`);
        set({ error: "Failed to install update" });
      }
    } finally {
      activeUpdates.delete(update);
      if (isCurrent()) set({ installing: false });
      else await closeUpdate(update);
    }
  },

  clearStatusMessage: () => {
    set({ statusMessage: null });
  },

  reset: async () => {
    const update = get().update;
    generation += 1;
    set({
      update: null,
      checking: false,
      downloading: false,
      downloaded: false,
      installing: false,
      progress: null,
      error: null,
      statusMessage: null,
    });
    await closeUpdate(update);
  },
}));
