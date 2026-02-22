export async function fireNotification(title: string, body: string) {
  try {
    const { isPermissionGranted, requestPermission, sendNotification } =
      await import("@tauri-apps/plugin-notification");

    let permitted = await isPermissionGranted();
    if (!permitted) {
      const result = await requestPermission();
      permitted = result === "granted";
    }
    if (permitted) {
      sendNotification({ title, body });
    }
  } catch {
    // Plugin not available (e.g., in browser dev mode)
  }
}
