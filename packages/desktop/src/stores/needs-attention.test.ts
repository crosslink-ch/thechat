import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  attentionThreadIds,
  conversationNeedsAttention,
  directMemberNeedsAttention,
  needsAttentionKvKey,
  needsAttentionScopeKey,
  scopeNeedsAttention,
  useNeedsAttentionStore,
} from "./needs-attention";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function useKv(initial: Record<string, string> = {}) {
  const values = { ...initial };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const input = args as
      | {
          key?: string;
          expectedValue?: string | null;
          value?: string | null;
        }
      | undefined;
    const key = input?.key ?? "";
    if (command === "kv_get") return values[key] ?? null;
    if (command === "kv_compare_and_set") {
      if ((values[key] ?? null) !== (input?.expectedValue ?? null)) return false;
      if (input?.value == null) delete values[key];
      else values[key] = input.value;
      return true;
    }
    if (command === "kv_set" && typeof input?.value === "string") {
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
          {
            conversationId: "dm-1",
            threadId: "task-1",
            workspaceId: "workspace-1",
            directUserId: "bot-user-1",
          },
        ],
      }),
    });

    await useNeedsAttentionStore.getState().initialize("user-1");

    const state = useNeedsAttentionStore.getState();
    expect(state.initialized).toBe(true);
    expect(scopeNeedsAttention(state.scopes, "channel-1")).toBe(true);
    expect(scopeNeedsAttention(state.scopes, "dm-1", "task-1")).toBe(true);
    expect(conversationNeedsAttention(state.scopes, "dm-1")).toBe(true);
    expect(
      directMemberNeedsAttention(state.scopes, "workspace-1", "bot-user-1"),
    ).toBe(true);
    expect(
      directMemberNeedsAttention(state.scopes, "workspace-2", "bot-user-1"),
    ).toBe(false);
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
      workspaceId: "workspace-1",
      directUserId: "bot-user-1",
    });

    const persisted = JSON.parse(values[needsAttentionKvKey("user-1")]);
    expect(persisted).toEqual({
      version: 1,
      scopes: [
        {
          conversationId: "dm-1",
          threadId: "task-1",
          workspaceId: "workspace-1",
          directUserId: "bot-user-1",
        },
      ],
    });
    expect(
      useNeedsAttentionStore.getState().scopes[
        needsAttentionScopeKey("dm-1", "task-1")
      ],
    ).toEqual({
      conversationId: "dm-1",
      threadId: "task-1",
      workspaceId: "workspace-1",
      directUserId: "bot-user-1",
    });

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

  it("rolls back to the last durable state after queued write failures", async () => {
    let persisted: string | undefined;
    let writeCount = 0;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      const input = args as { value?: string | null } | undefined;
      if (command === "kv_get") return persisted ?? null;
      if (command === "kv_compare_and_set") {
        writeCount += 1;
        if (writeCount > 1) throw new Error("write failed");
        persisted = input?.value ?? undefined;
        return true;
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    await useNeedsAttentionStore.getState().initialize("user-1");

    const firstWrite = useNeedsAttentionStore.getState().toggle({
      conversationId: "channel-a",
      threadId: null,
    });
    const secondWrite = useNeedsAttentionStore.getState().toggle({
      conversationId: "channel-b",
      threadId: null,
    });
    const thirdWrite = useNeedsAttentionStore.getState().toggle({
      conversationId: "channel-a",
      threadId: null,
    });
    await Promise.all([firstWrite, secondWrite, thirdWrite]);

    expect(JSON.parse(persisted ?? "null")).toEqual({
      version: 1,
      scopes: [{ conversationId: "channel-a", threadId: null }],
    });
    expect(useNeedsAttentionStore.getState()).toMatchObject({
      scopes: {
        [needsAttentionScopeKey("channel-a")]: {
          conversationId: "channel-a",
          threadId: null,
        },
      },
      error: "write failed",
    });
  });

  it("fails closed when the initial SQLite read fails", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("database unavailable"));

    await useNeedsAttentionStore.getState().initialize("user-1");
    const result = await useNeedsAttentionStore.getState().toggle({
      conversationId: "channel-a",
      threadId: null,
    });

    expect(result).toBe(false);
    expect(useNeedsAttentionStore.getState()).toMatchObject({
      activeUserId: "user-1",
      initialized: false,
      scopes: {},
      error: "database unavailable",
    });
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
  });

  it("merges a concurrent desktop write before committing its own marker", async () => {
    let persisted = JSON.stringify({
      version: 1,
      scopes: [{ conversationId: "channel-a", threadId: null }],
    });
    let compareAttempts = 0;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      const input = args as
        | { expectedValue?: string | null; value?: string | null }
        | undefined;
      if (command === "kv_get") return persisted;
      if (command === "kv_compare_and_set") {
        compareAttempts += 1;
        if (compareAttempts === 1) {
          persisted = JSON.stringify({
            version: 1,
            scopes: [
              { conversationId: "channel-a", threadId: null },
              { conversationId: "channel-b", threadId: null },
            ],
          });
          return false;
        }
        expect(input?.expectedValue).toBe(persisted);
        persisted = input?.value ?? "";
        return true;
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    await useNeedsAttentionStore.getState().initialize("user-1");
    await useNeedsAttentionStore.getState().toggle({
      conversationId: "channel-c",
      threadId: null,
    });

    expect(compareAttempts).toBe(2);
    expect(Object.keys(useNeedsAttentionStore.getState().scopes).sort()).toEqual(
      [
        needsAttentionScopeKey("channel-a"),
        needsAttentionScopeKey("channel-b"),
        needsAttentionScopeKey("channel-c"),
      ].sort(),
    );
    expect(JSON.parse(persisted).scopes).toHaveLength(3);
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
