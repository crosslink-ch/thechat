export async function checkForUpdates(silent = true) {
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const { relaunch } = await import("@tauri-apps/plugin-process");
    const { ask } = await import("@tauri-apps/plugin-dialog");

    const update = await check();
    if (!update) return;

    const confirmed = await ask(
      `Version ${update.version} is available. Do you want to update and restart?`,
      { title: "Update Available", kind: "info" },
    );
    if (!confirmed) return;

    await update.downloadAndInstall();
    await relaunch();
  } catch {
    if (!silent) throw new Error("Update check failed");
  }
}
