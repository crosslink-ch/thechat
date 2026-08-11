import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  attentionThreadIds,
  conversationNeedsAttention,
  needsAttentionKvKey,
  needsAttentionScopeKey,
  scopeNeedsAttention,
  useNeedsAttentionStore,
} from "./needs-attention";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function useKv(initial: Record<string, string> = {}) {
  const values = { ...initial };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const input = args as { key?: string; value?: string } | undefined;
    const key = input?.key ?? "";
    if (command === "kv_get") return values[key] ?? null;
    if (command === "kv_set" && input?.value !== undefined) {
      values[key] = input.value;
      return null;
    }
    if (command === "kv_delete") {
      delete values[key];
      return null;
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  return values;
}

beforeEach(() => {
  vi.clearAllMocks();
  useNeedsAttentionStore.getState().resetForTests();
  useKv();
});

describe("needs attention store", () => {
  it("hydrates account-scoped conversation and Hermes task markers", async () => {
    const key = needsAttentionKvKey("user-1");
    useKv({
      [key]: JSON.stringify({
        version: 1,
        scopes: [
          { conversationId: "channel-1", threadId: null },
          { conversationId: "dm-1", threadId: "task-1" },
        ],
      }),
    });

    await useNeedsAttentionStore.getState().initialize("user-1");

    const state = useNeedsAttentionStore.getState();
    expect(state.initialized).toBe(true);
    expect(scopeNeedsAttention(state.scopes, "channel-1")).toBe(true);
    expect(scopeNeedsAttention(state.scopes, "dm-1", "task-1")).toBe(true);
    expect(conversationNeedsAttention(state.scopes, "dm-1")).toBe(true);
    expect(attentionThreadIds(state.scopes, "dm-1")).toEqual(
      new Set(["task-1"]),
    );
  });

  it("persists a task marker to SQLite kv storage and removes it on toggle", async () => {
    const values = useKv();
    await useNeedsAttentionStore.getState().initialize("user-1");

    await useNeedsAttentionStore.getState().toggle({
      conversationId: "dm-1",
      threadId: "task-1",
    });

    const persisted = JSON.parse(values[needsAttentionKvKey("user-1")]);
    expect(persisted).toEqual({
      version: 1,
      scopes: [{ conversationId: "dm-1", threadId: "task-1" }],
    });
    expect(
      useNeedsAttentionStore.getState().scopes[
        needsAttentionScopeKey("dm-1", "task-1")
      ],
    ).toEqual({ conversationId: "dm-1", threadId: "task-1" });

    await useNeedsAttentionStore.getState().toggle({
      conversationId: "dm-1",
      threadId: "task-1",
    });
    expect(values[needsAttentionKvKey("user-1")]).toBeUndefined();
    expect(useNeedsAttentionStore.getState().scopes).toEqual({});
  });

  it("keeps markers isolated between signed-in users", async () => {
    const values = useKv();
    await useNeedsAttentionStore.getState().initialize("user-1");
    await useNeedsAttentionStore.getState().toggle({
      conversationId: "channel-1",
      threadId: null,
    });

    await useNeedsAttentionStore.getState().initialize("user-2");
    expect(useNeedsAttentionStore.getState().scopes).toEqual({});
    expect(values[needsAttentionKvKey("user-1")]).toContain("channel-1");
    expect(values[needsAttentionKvKey("user-2")]).toBeUndefined();
  });

  it("recovers safely from malformed local data", async () => {
    useKv({ [needsAttentionKvKey("user-1")]: "not-json" });

    await useNeedsAttentionStore.getState().initialize("user-1");

    expect(useNeedsAttentionStore.getState()).toMatchObject({
      activeUserId: "user-1",
      initialized: true,
      scopes: {},
      error: null,
    });
  });
});
