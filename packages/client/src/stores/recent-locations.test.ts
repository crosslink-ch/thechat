import { beforeEach, describe, expect, it, vi } from "vitest";

const stored = vi.hoisted(() => new Map<string, string>());
vi.mock("../platform/preferences", () => ({
  preferences: {
    get: vi.fn(async (key: string) => stored.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => void stored.set(key, value)),
    delete: vi.fn(async (key: string) => void stored.delete(key)),
  },
}));

import { useRecentLocationsStore } from "./recent-locations";

beforeEach(async () => {
  stored.clear();
  await useRecentLocationsStore.getState().load(null);
});

describe("recent locations", () => {
  it("keeps visits newest first, without duplicates, and persists them", async () => {
    const store = useRecentLocationsStore.getState();
    await store.load("alice");
    store.enter({ conversationId: "ch-1", type: "group", threadId: null });
    store.enter({ conversationId: "dm-koda", type: "direct", threadId: "t-9" });
    store.enter({ conversationId: "ch-1", type: "group", threadId: null });
    expect(useRecentLocationsStore.getState().keys).toEqual(["ch-1", "dm-koda:t-9"]);
    expect(JSON.parse(stored.get("recent_locations")!)).toEqual({ userId: "alice", keys: ["ch-1", "dm-koda:t-9"] });
  });

  it("never shows one person's recents to another on the same device", async () => {
    stored.set("recent_locations", JSON.stringify({ userId: "alice", keys: ["secret-dm"] }));
    await useRecentLocationsStore.getState().load("bob");
    expect(useRecentLocationsStore.getState().keys).toEqual([]);
    await useRecentLocationsStore.getState().load("alice");
    expect(useRecentLocationsStore.getState().keys).toEqual(["secret-dm"]);
  });

  it("tracks the conversation on screen until it is left", async () => {
    const store = useRecentLocationsStore.getState();
    await store.load("alice");
    store.enter({ conversationId: "ch-1", type: "group", threadId: null });
    expect(useRecentLocationsStore.getState().current).toEqual({ conversationId: "ch-1", type: "group", threadId: null });
    store.leave("other");
    expect(useRecentLocationsStore.getState().current?.conversationId).toBe("ch-1");
    store.leave("ch-1");
    expect(useRecentLocationsStore.getState().current).toBeNull();
  });

  it("ignores a corrupt stored value", async () => {
    stored.set("recent_locations", "{not json");
    await useRecentLocationsStore.getState().load("alice");
    expect(useRecentLocationsStore.getState().keys).toEqual([]);
  });
});
