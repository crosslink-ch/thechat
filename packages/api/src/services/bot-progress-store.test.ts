import { describe, expect, test } from "bun:test";
import type { BotProgressStore } from "./bot-progress-store";
import {
  createLocalBotProgressStoreForTests,
  createResilientBotProgressStoreForTests,
} from "./bot-progress-store";

describe("local bot progress store", () => {
  test("indexes progress by conversation and expires inactive work", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const store = createLocalBotProgressStoreForTests({
      activityTimeoutMs: 30_000,
      now: () => now,
    });

    await store.append(progressInput({ invocationId: "invocation-1" }));
    await store.append(progressInput({
      invocationId: "invocation-2",
      threadId: "thread-2",
      toolCallId: "call-2",
    }));

    expect((await store.listForConversation("conversation-1")).map((event) => event.invocationId)).toEqual([
      "invocation-1",
      "invocation-2",
    ]);
    expect(await store.listForConversation("conversation-2")).toEqual([]);

    now += 30_001;
    expect(await store.listForConversation("conversation-1")).toEqual([]);

    await store.touch({
      invocationId: "invocation-2",
      conversationId: "conversation-1",
    });
    expect((await store.listForConversation("conversation-1")).map((event) => event.invocationId)).toEqual([
      "invocation-2",
    ]);
  });

  test("retains unresolved approvals without a heartbeat", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const store = createLocalBotProgressStoreForTests({
      activityTimeoutMs: 30_000,
      now: () => now,
    });

    await store.append(progressInput({
      type: "approval.request",
      toolCallId: null,
      payload: { sessionKey: "session-1" },
    }));
    await store.append(progressInput({
      type: "approval.request",
      toolCallId: null,
      payload: { sessionKey: "session-1" },
    }));
    now += 30_001;

    expect(await store.listForConversation("conversation-1")).toHaveLength(2);

    await store.append(progressInput({
      type: "approval.resolved",
      toolCallId: null,
      payload: { sessionKey: "session-1", resolvedCount: 2 },
    }));
    now += 30_001;

    expect(await store.listForConversation("conversation-1")).toEqual([]);
  });

  test("clear removes events and the conversation index", async () => {
    const store = createLocalBotProgressStoreForTests();
    await store.append(progressInput());

    await store.clear({
      invocationId: "invocation-1",
      conversationId: "conversation-1",
    });

    expect(await store.listForConversation("conversation-1")).toEqual([]);
  });
});

describe("resilient bot progress store", () => {
  test("merges fallback events after the primary store recovers", async () => {
    let primaryAvailable = false;
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const storeOptions = {
      activityTimeoutMs: 30_000,
      now: () => now,
    };
    const primaryLocal = createLocalBotProgressStoreForTests(storeOptions);
    const fallback = createLocalBotProgressStoreForTests(storeOptions);
    const primary: BotProgressStore = {
      append: (input) => primaryAvailable
        ? primaryLocal.append(input)
        : Promise.reject(new Error("primary unavailable")),
      touch: (input) => primaryAvailable
        ? primaryLocal.touch(input)
        : Promise.reject(new Error("primary unavailable")),
      listForConversation: (conversationId, candidates) => primaryAvailable
        ? primaryLocal.listForConversation(conversationId, candidates)
        : Promise.reject(new Error("primary unavailable")),
      clear: (input) => primaryLocal.clear(input),
      close: () => primaryLocal.close?.() ?? Promise.resolve(),
    };
    const store = createResilientBotProgressStoreForTests(primary, fallback);

    await store.append(progressInput({
      type: "approval.request",
      toolCallId: null,
      occurredAt: new Date(now),
    }));
    now += 31_000;
    primaryAvailable = true;
    await store.append(progressInput({
      type: "tool.started",
      occurredAt: new Date(now),
    }));

    const merged = await store.listForConversation("conversation-1");
    expect(merged.map((event) => event.type)).toEqual([
      "approval.request",
      "tool.started",
    ]);
    expect(merged.map((event) => event.sequence)).toEqual([1, 2]);
    await store.close?.();
  });
});

function progressInput(
  overrides: Partial<Parameters<BotProgressStore["append"]>[0]> = {},
): Parameters<BotProgressStore["append"]>[0] {
  return {
    invocationId: "invocation-1",
    botId: "bot-1",
    conversationId: "conversation-1",
    threadId: null,
    type: "tool.started",
    status: "running",
    toolCallId: "call-1",
    toolName: "shell",
    label: "Shell",
    preview: null,
    payload: null,
    occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}
