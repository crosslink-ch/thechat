import { describe, expect, it } from "vitest";
import { createReleaseNotesSeenState } from "./release-notes-state";

describe("release notes dismissal", () => {
  it.each(["access", "read", "write"])("keeps in-session dismissal when storage %s throws", (failure) => {
    const fail = () => { throw new Error("Storage blocked"); };
    const seen = createReleaseNotesSeenState(() => {
      if (failure === "access") return fail();
      return {
        getItem: failure === "read" ? fail : () => null,
        setItem: failure === "write" ? fail : () => {},
      };
    });
    expect(seen.hasSeen("blocked-user", "0.9.0")).toBe(false);
    seen.dismiss("blocked-user", "0.9.0");
    expect(seen.hasSeen("blocked-user", "0.9.0")).toBe(true);
    expect(seen.hasSeen("other-user", "0.9.0")).toBe(false);
  });
  it("remembers a dismissed version across reloads, but not for another user or version", () => {
    const storage = new Map<string, string>();
    const getStorage = () => ({
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
    });
    const firstSession = createReleaseNotesSeenState(getStorage);
    expect(firstSession.hasSeen("alice", "0.9.0")).toBe(false);
    firstSession.dismiss("alice", "0.9.0");
    const reloaded = createReleaseNotesSeenState(getStorage);
    expect(reloaded.hasSeen("alice", "0.9.0")).toBe(true);
    expect(reloaded.hasSeen("bob", "0.9.0")).toBe(false);
    expect(reloaded.hasSeen("alice", "0.9.1")).toBe(false);
  });
});
