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

  test("gives approval and clarify progress no special retention", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const store = createLocalBotProgressStoreForTests({
      activityTimeoutMs: 30_000,
      now: () => now,
    });
    await store.append(progressInput({
      type: "approval.request",
      toolCallId: null,
      payload: { requestId: "approval-1", sessionKey: "session-1" },
    }));
    await store.append(progressInput({
      type: "clarify.request",
      toolCallId: null,
      payload: { requestId: "clarify-1", sessionKey: "session-1" },
    }));
    now += 30_001;
    expect(await store.listForConversation("conversation-1")).toEqual([]);
  });

  test("reuses one stable vault request event for an ambiguous retry", async () => {
    const store = createLocalBotProgressStoreForTests();
    const input = progressInput({
      type: "vault.unlock.request",
      toolCallId: null,
      payload: {
        version: 2,
        requestId: "vault-stable",
        sessionKey: "session-1",
        expiresAt: Date.now() + 120_000,
      },
    });

    const first = await store.append(input);
    const retry = await store.append({ ...input, occurredAt: new Date() });

    expect(retry).toEqual(first);
    expect(await store.listForConversation("conversation-1")).toEqual([first]);
  });

  test("retains a vault request past inactivity and overflow only until its expiry", async () => {
    let now = Date.now();
    const store = createLocalBotProgressStoreForTests({now:()=>now,maxEvents:2});
    const event = await store.append(progressInput({type:"vault.unlock.request",payload:{version:2,requestId:"vault",sessionKey:"session",expiresAt:now+120000}}));
    for (let i=0;i<4;i++) await store.append(progressInput({toolCallId:`overflow-${i}`}));
    now+=31000;
    expect(await store.listForConversation("conversation-1")).toContainEqual(event);
    now+=90000;
    expect(await store.listForConversation("conversation-1")).toEqual([]);
    expect(await store.findRequest?.("invocation-1","vault.unlock.request","vault")).toEqual(event);
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
  redisTest("retains metadata for expiry resolution without keeping an expired prompt active", async () => {
    let now = Date.now();
    const store = createRedisBotProgressStoreForTests({redisUrl:redisTestUrl!,redisKeyPrefix:`vault-store-${crypto.randomUUID()}`,maxEvents:2,now:()=>now});
    try {
      const request = await store.append(progressInput({type:"vault.unlock.request",payload:{version:2,requestId:"redis-vault",sessionKey:"session",expiresAt:now+120000}}));
      for(let i=0;i<4;i++) await store.append(progressInput({toolCallId:`overflow-${i}`}));
      now+=31000;
      expect(await store.listForConversation("conversation-1")).toContainEqual(request);
      now+=90000;
      expect(await store.listForConversation("conversation-1")).toEqual([]);
      expect(await store.findRequest?.("invocation-1","vault.unlock.request","redis-vault")).toEqual(request);
    } finally { await store.clear({invocationId:"invocation-1",conversationId:"conversation-1"});await store.close?.(); }
  });

  redisTest("deduplicates retries and retains a live request beyond the list cap", async () => {
    const store = createRedisBotProgressStoreForTests({
      redisUrl: redisTestUrl!,
      redisKeyPrefix: `thechat-test-${crypto.randomUUID()}`,
      maxEvents: 3,
    });
    try {
      const input = progressInput({
        type: "vault.unlock.request",
        toolCallId: null,
        payload: {
          version: 2,
          requestId: "redis-stable",
          sessionKey: "session-redis",
          expiresAt: Date.now() + 120_000,
        },
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
      type: "notice.lifecycle",
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
      "notice.lifecycle",
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
