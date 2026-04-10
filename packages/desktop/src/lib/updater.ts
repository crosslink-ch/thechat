import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";
import { error as logError, formatError, info as logInfo } from "../log";

export async function checkForUpdates(): Promise<Update | null> {
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();

    if (update) {
      logInfo(`[updater] Update available ${update.currentVersion} -> ${update.version}`);
    } else {
      logInfo("[updater] No update available");
    }

    return update;
  } catch (error) {
    logError(`[updater] Update check failed: ${formatError(error)}`);
    throw error instanceof Error ? error : new Error("Update check failed");
  }
}

export async function downloadUpdate(
  update: Update,
  onEvent?: (event: DownloadEvent) => void,
): Promise<void> {
  try {
    logInfo(`[updater] Downloading update ${update.currentVersion} -> ${update.version}`);
    await update.download((event) => {
      if (event.event === "Started") {
        logInfo(
          `[updater] Download started for ${update.version} (${event.data.contentLength ?? "unknown"} bytes)`,
        );
      }

      if (event.event === "Finished") {
        logInfo(`[updater] Download finished for ${update.version}`);
      }

      onEvent?.(event);
    });
  } catch (error) {
    logError(`[updater] Update download failed: ${formatError(error)}`);
    throw error instanceof Error ? error : new Error("Update download failed");
  }
}

export async function installAndRelaunch(update: Update): Promise<void> {
  try {
    const { relaunch } = await import("@tauri-apps/plugin-process");

    logInfo(`[updater] Installing update ${update.version} and relaunching`);
    await update.install();
    await relaunch();
  } catch (error) {
    logError(`[updater] Update install failed: ${formatError(error)}`);
    throw error instanceof Error ? error : new Error("Update install failed");
  }
}

export async function disposeUpdate(update: Update | null): Promise<void> {
  if (!update) return;

  try {
    await update.close();
  } catch (error) {
    logError(`[updater] Failed to close update handle: ${formatError(error)}`);
  }
}
