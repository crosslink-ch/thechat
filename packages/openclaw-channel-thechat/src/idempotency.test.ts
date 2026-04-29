import { describe, test, expect, beforeEach } from "bun:test";
import { createIdempotencyStore, type IdempotencyStore } from "./idempotency.js";

describe("createIdempotencyStore", () => {
  let store: IdempotencyStore;
  let clock: number;

  beforeEach(() => {
    clock = 1_000_000;
    store = createIdempotencyStore({
      ttlMs: 10_000,
      sweepIntervalMs: 999_999, // disable passive sweep in tests
      nowMs: () => clock,
      maxEntries: 5,
    });
  });

  test("check returns false for unseen keys", () => {
    expect(store.check("msg-1")).toBe(false);
  });

  test("mark returns true for new keys", () => {
    expect(store.mark("msg-1")).toBe(true);
    expect(store.size()).toBe(1);
  });

  test("mark returns false for already-seen keys", () => {
    store.mark("msg-1");
    expect(store.mark("msg-1")).toBe(false);
    expect(store.size()).toBe(1);
  });

  test("check returns true for previously marked keys", () => {
    store.mark("msg-1");
    expect(store.check("msg-1")).toBe(true);
  });

  test("expired entries are treated as unseen by check", () => {
    store.mark("msg-1");
    // Advance past TTL.
    clock += 10_001;
    expect(store.check("msg-1")).toBe(false);
  });

  test("expired entries can be re-marked", () => {
    store.mark("msg-1");
    clock += 10_001;
    expect(store.mark("msg-1")).toBe(true);
    expect(store.size()).toBe(1);
  });

  test("sweep removes expired entries", () => {
    store.mark("msg-1");
    store.mark("msg-2");
    clock += 5_000;
    store.mark("msg-3"); // this one is still fresh
    clock += 5_001; // msg-1 and msg-2 are now expired; msg-3 is not
    const swept = store.sweep();
    expect(swept).toBe(2);
    expect(store.size()).toBe(1);
    expect(store.check("msg-3")).toBe(true);
  });

  test("auto-sweeps when maxEntries is reached", () => {
    // Fill to maxEntries (5)
    for (let i = 0; i < 5; i++) {
      store.mark(`msg-${i}`);
    }
    expect(store.size()).toBe(5);

    // Expire first 3
    clock += 10_001;
    // Re-mark the last 2 so they're fresh
    store.mark("msg-3");
    store.mark("msg-4");

    // Now add a 6th — should trigger sweep, removing expired entries
    store.mark("msg-new");
    // After sweep: msg-3, msg-4 survived + msg-new = 3
    expect(store.size()).toBe(3);
  });

  test("dispose clears all entries", () => {
    store.mark("msg-1");
    store.mark("msg-2");
    store.dispose();
    expect(store.size()).toBe(0);
    expect(store.check("msg-1")).toBe(false);
  });

  test("multiple independent stores don't interfere", () => {
    const store2 = createIdempotencyStore({
      ttlMs: 10_000,
      sweepIntervalMs: 999_999,
      nowMs: () => clock,
    });
    store.mark("msg-1");
    expect(store2.check("msg-1")).toBe(false);
    store2.dispose();
  });
});
