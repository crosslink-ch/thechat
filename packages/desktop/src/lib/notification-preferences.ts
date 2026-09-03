const DESKTOP_NOTIFICATIONS_KEY_PREFIX = "thechat:desktop-notifications:";
const volatilePreferences = new Map<string, boolean>();

function storageKey(userId: string) {
  return `${DESKTOP_NOTIFICATIONS_KEY_PREFIX}${userId}`;
}

export function desktopNotificationsEnabled(userId: string) {
  try {
    const stored = localStorage.getItem(storageKey(userId));
    if (stored !== null) {
      return stored !== "false";
    }
  } catch {
    // Fall back to the current-session value below.
  }

  return volatilePreferences.get(userId) ?? true;
}

export function setDesktopNotificationsEnabled(
  userId: string,
  enabled: boolean,
) {
  try {
    localStorage.setItem(storageKey(userId), String(enabled));
    volatilePreferences.delete(userId);
  } catch {
    volatilePreferences.set(userId, enabled);
  }
}
