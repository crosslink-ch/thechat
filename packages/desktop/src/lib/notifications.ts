import { desktopNotificationsEnabled } from "./notification-preferences";
import { useAuthStore } from "../stores/auth";

type FireNotificationOptions = {
  dedupeKey?: string;
  dedupeMs?: number;
};

const DEFAULT_DEDUPE_MS = 5_000;
const GLOBAL_NOTIFICATION_COOLDOWN_MS = 5_000;
const MAX_DEDUPE_AGE_MS = 60_000;

const globalScope = globalThis as typeof globalThis & {
  __thechatNotificationDeduper?: Map<string, number>;
  __thechatNotificationLastAttemptAt?: number;
  __thechatNotificationLastSentAt?: number;
};

function recentNotifications() {
  globalScope.__thechatNotificationDeduper ??= new Map();
  return globalScope.__thechatNotificationDeduper;
}

function shouldSuppressNotificationAttempt(key: string, dedupeMs: number) {
  const now = Date.now();
  const seen = recentNotifications();
  for (const [seenKey, seenAt] of seen) {
    if (now - seenAt > MAX_DEDUPE_AGE_MS) {
      seen.delete(seenKey);
    }
  }

  const previous = seen.get(key);
  if (previous !== undefined && now - previous < dedupeMs) {
    return true;
  }

  const lastAttemptAt = globalScope.__thechatNotificationLastAttemptAt;
  if (
    lastAttemptAt !== undefined &&
    now - lastAttemptAt < GLOBAL_NOTIFICATION_COOLDOWN_MS
  ) {
    return true;
  }

  seen.set(key, now);
  globalScope.__thechatNotificationLastAttemptAt = now;
  return false;
}

function shouldSuppressNotificationSend() {
  const now = Date.now();
  const lastSentAt = globalScope.__thechatNotificationLastSentAt;
  if (
    lastSentAt !== undefined &&
    now - lastSentAt < GLOBAL_NOTIFICATION_COOLDOWN_MS
  ) {
    return true;
  }

  globalScope.__thechatNotificationLastSentAt = now;
  return false;
}

export async function fireNotification(
  title: string,
  body: string,
  options: FireNotificationOptions = {},
) {
  const currentUserId = useAuthStore.getState().user?.id;
  if (
    currentUserId &&
    !desktopNotificationsEnabled(currentUserId)
  ) {
    return;
  }

  const dedupeKey = options.dedupeKey ?? `${title}\u0000${body}`;
  if (
    shouldSuppressNotificationAttempt(
      dedupeKey,
      options.dedupeMs ?? DEFAULT_DEDUPE_MS,
    )
  ) {
    return;
  }

  try {
    const { isPermissionGranted, requestPermission, sendNotification } =
      await import("@tauri-apps/plugin-notification");

    let permitted = await isPermissionGranted();
    if (!permitted) {
      const result = await requestPermission();
      permitted = result === "granted";
    }
    if (permitted && !shouldSuppressNotificationSend()) {
      sendNotification({ title, body });
    }
  } catch {
    // Plugin not available (e.g., in browser dev mode)
  }
}
