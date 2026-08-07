import { describe, expect, test } from "bun:test";
import crypto from "crypto";
import type { BotProgressStore } from "./bot-progress-store";
import {
  createLocalBotProgressStoreForTests,
  createRedisBotProgressStoreForTests,
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

  test("retains clarifications and resolves an explicit requestId", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const store = createLocalBotProgressStoreForTests({
      activityTimeoutMs: 30_000,
      now: () => now,
    });
    await store.append(progressInput({
      type: "clarify.request",
      toolCallId: null,
      payload: { requestId: "clarify-1", sessionKey: "session-1" },
    }));
    await store.append(progressInput({
      type: "clarify.request",
      toolCallId: null,
      payload: { requestId: "clarify-2", sessionKey: "session-1" },
    }));
    await store.append(progressInput({
      type: "clarify.resolved",
      toolCallId: null,
      payload: { requestId: "clarify-2", sessionKey: "session-1" },
    }));
    now += 30_001;

    const retained = await store.listForConversation("conversation-1");
    expect(retained.map((event) => event.type)).toEqual([
      "clarify.request",
      "clarify.request",
      "clarify.resolved",
    ]);

    await store.append(progressInput({
      type: "clarify.resolved",
      toolCallId: null,
      payload: { requestId: "clarify-1", sessionKey: "session-1" },
    }));
    now += 30_001;
    expect(await store.listForConversation("conversation-1")).toEqual([]);
  });

  test("reuses one stable request event for an ambiguous retry", async () => {
    const store = createLocalBotProgressStoreForTests();
    const input = progressInput({
      type: "approval.request",
      toolCallId: null,
      payload: { requestId: "approval-stable", sessionKey: "session-1" },
    });

    const first = await store.append(input);
    const retry = await store.append({ ...input, occurredAt: new Date() });

    expect(retry).toEqual(first);
    expect(await store.listForConversation("conversation-1")).toEqual([first]);
  });

  test("never compacts an unresolved interaction request at the event cap", async () => {
    const store = createLocalBotProgressStoreForTests({ maxEvents: 3 });
    const request = await store.append(progressInput({
      type: "clarify.request",
      toolCallId: null,
      payload: { requestId: "clarify-overflow", sessionKey: "session-1" },
    }));
    for (let index = 0; index < 8; index += 1) {
      await store.append(progressInput({
        toolCallId: `call-${index}`,
        payload: { index },
      }));
    }

    const retained = await store.listForConversation("conversation-1");
    expect(retained).toHaveLength(4);
    expect(retained).toContainEqual(request);

    await store.append(progressInput({
      type: "clarify.resolved",
      toolCallId: null,
      payload: {
        requestId: "clarify-overflow",
        sessionKey: "session-1",
        response: "done",
      },
    }));
    expect(
      (await store.listForConversation("conversation-1")).some(
        (event) => event.id === request.id,
      ),
    ).toBe(false);
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

const redisTestUrl = process.env.TEST_REDIS_URL;
const redisTest = redisTestUrl ? test : test.skip;

describe("redis bot progress store", () => {
  redisTest("deduplicates retries and retains a live request beyond the list cap", async () => {
    const store = createRedisBotProgressStoreForTests({
      redisUrl: redisTestUrl!,
      redisKeyPrefix: `thechat-test-${crypto.randomUUID()}`,
      maxEvents: 3,
    });
    try {
      const input = progressInput({
        type: "approval.request",
        toolCallId: null,
        payload: { requestId: "redis-stable", sessionKey: "session-redis" },
      });
      const first = await Promise.all([
        store.append(input),
        store.append({ ...input, occurredAt: new Date() }),
      ]);
      expect(first[1]).toEqual(first[0]);

      for (let index = 0; index < 8; index += 1) {
        await store.append(progressInput({ toolCallId: `redis-call-${index}` }));
      }
      const retained = await store.listForConversation("conversation-1");
      expect(retained.filter((event) => event.id === first[0].id)).toHaveLength(1);
      expect(retained).toHaveLength(4);
    } finally {
      await store.clear({
        invocationId: "invocation-1",
        conversationId: "conversation-1",
      });
      await store.close?.();
    }
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
