type SeenStorage = Pick<Storage, "getItem" | "setItem">;

/** Per-account, per-version dismissal. No token or server call is needed. */
export function createReleaseNotesSeenState(getStorage: () => SeenStorage) {
  const keyFor = (userId: string, version: string) =>
    `thechat:release-notes:seen:${encodeURIComponent(userId)}:${encodeURIComponent(version)}`;
  const sessionSeen = new Set<string>();
  const sessionPreferences = new Map<string, boolean>();
  const preferenceKey = (userId: string) =>
    `thechat:release-notes:automatic-disabled:${encodeURIComponent(userId)}`;
  return {
    isAutomaticDisabled(userId: string) {
      if (sessionPreferences.has(userId)) return sessionPreferences.get(userId)!;
      try {
        return getStorage().getItem(preferenceKey(userId)) === "1";
      } catch {
        return false;
      }
    },
    setAutomaticDisabled(userId: string, disabled: boolean) {
      sessionPreferences.set(userId, disabled);
      try {
        getStorage().setItem(preferenceKey(userId), disabled ? "1" : "0");
      } catch {
        // Keep the preference for this session if storage is blocked or full.
      }
    },
    hasSeen(userId: string, version: string) {
      const key = keyFor(userId, version);
      if (sessionSeen.has(key)) return true;
      try {
        return getStorage().getItem(key) === "1";
      } catch {
        return false;
      }
    },
    dismiss(userId: string, version: string) {
      const key = keyFor(userId, version);
      sessionSeen.add(key);
      try {
        getStorage().setItem(key, "1");
      } catch {
        // Privacy settings/quota must not interrupt the app or repeat this session.
      }
    },
  };
}

export const releaseNotesSeen = createReleaseNotesSeenState(() => window.localStorage);
