import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotRuntimeSnapshot } from "@thechat/shared";
import { useBotRuntimeStore } from "./bot-runtime";

describe("useBotRuntimeStore", () => {
  beforeEach(() => {
    useBotRuntimeStore.getState().clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reuses fresh cached runtime snapshots", async () => {
    const snapshot = runtime();
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(snapshot),
      } as Response),
    );
    vi.stubGlobal("fetch", fetchMock);

    await useBotRuntimeStore.getState().fetchRuntime("conversation-1", "token-1");
    await useBotRuntimeStore.getState().fetchRuntime("conversation-1", "token-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useBotRuntimeStore.getState().entries["conversation-1"]?.runtime).toEqual(
      snapshot,
    );
  });

  it("keeps cached runtime visible when a refresh fails", async () => {
    const snapshot = runtime();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(snapshot),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as Response);
    vi.stubGlobal("fetch", fetchMock);

    await useBotRuntimeStore.getState().fetchRuntime("conversation-1", "token-1");
    await useBotRuntimeStore
      .getState()
      .fetchRuntime("conversation-1", "token-1", { force: true });

    const entry = useBotRuntimeStore.getState().entries["conversation-1"];
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(entry?.runtime).toEqual(snapshot);
    expect(entry?.loading).toBe(false);
    expect(entry?.error).toContain("HTTP 500");
  });
});

function runtime(): BotRuntimeSnapshot {
  return {
    sessions: [],
    invocations: [],
    events: [],
  };
}
