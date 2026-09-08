type SeenStorage = Pick<Storage, "getItem" | "setItem">;

/** Per-account, per-version dismissal. No token or server call is needed. */
export function createReleaseNotesSeenState(getStorage: () => SeenStorage) {
  const keyFor = (userId: string, version: string) =>
    `thechat:release-notes:seen:${encodeURIComponent(userId)}:${encodeURIComponent(version)}`;
  const sessionSeen = new Set<string>();
  return {
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
