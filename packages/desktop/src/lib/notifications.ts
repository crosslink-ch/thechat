type FireNotificationOptions = {
  dedupeKey?: string;
  dedupeMs?: number;
};

const DEFAULT_DEDUPE_MS = 5_000;
const MAX_DEDUPE_AGE_MS = 60_000;

const globalScope = globalThis as typeof globalThis & {
  __thechatNotificationDeduper?: Map<string, number>;
};

function recentNotifications() {
  globalScope.__thechatNotificationDeduper ??= new Map();
  return globalScope.__thechatNotificationDeduper;
}

function shouldSuppressNotification(key: string, dedupeMs: number) {
  const now = Date.now();
  const seen = recentNotifications();
  for (const [seenKey, seenAt] of seen) {
    if (now - seenAt > MAX_DEDUPE_AGE_MS) {
      seen.delete(seenKey);
    }
  }

  const previous = seen.get(key);
  if (previous && now - previous < dedupeMs) {
    return true;
  }

  seen.set(key, now);
  return false;
}

export async function fireNotification(
  title: string,
  body: string,
  options: FireNotificationOptions = {},
) {
  try {
    const { isPermissionGranted, requestPermission, sendNotification } =
      await import("@tauri-apps/plugin-notification");

    let permitted = await isPermissionGranted();
    if (!permitted) {
      const result = await requestPermission();
      permitted = result === "granted";
    }
    if (permitted) {
      const dedupeKey = options.dedupeKey ?? `${title}\u0000${body}`;
      if (shouldSuppressNotification(dedupeKey, options.dedupeMs ?? DEFAULT_DEDUPE_MS)) {
        return;
      }
      sendNotification({ title, body });
    }
  } catch {
    // Plugin not available (e.g., in browser dev mode)
  }
}
