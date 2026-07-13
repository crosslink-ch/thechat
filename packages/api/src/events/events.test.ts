import { describe, expect, test } from "bun:test";
import {
  CHAT_MESSAGE_SENT_EVENT_TYPE,
  createChatMessageSentV1,
  parseChatMessageSentV1,
  parseDomainEventEnvelope,
  type DomainEventEnvelope,
} from "./envelope";
import { loadDomainEventsConfig } from "./config";
import {
  DomainEventRegistry,
  InvalidDomainEventError,
  PermanentDomainEventError,
} from "./registry";
import { retryDelayMs } from "./retry";

const ids = {
  message: "11111111-1111-4111-8111-111111111111",
  conversation: "22222222-2222-4222-8222-222222222222",
  sender: "33333333-3333-4333-8333-333333333333",
  bot: "44444444-4444-4444-8444-444444444444",
};

describe("domain event envelopes", () => {
  test("creates and parses the minimal chat.message.sent v1 envelope", () => {
    const event = createChatMessageSentV1({
      messageId: ids.message,
      conversationId: ids.conversation,
      targetBotIds: [ids.bot],
      messageKind: "user",
      automationDepth: 0,
      senderId: ids.sender,
      senderType: "human",
      workspaceId: "workspace-one",
      occurredAt: new Date("2026-07-09T12:00:00.000Z"),
    });

    expect(parseChatMessageSentV1(event)).toEqual(event);
    expect(event).toMatchObject({
      type: CHAT_MESSAGE_SENT_EVENT_TYPE,
      version: 1,
      aggregate: { type: "message", id: ids.message },
      actor: { type: "human", id: ids.sender },
      tenant: { workspaceId: "workspace-one" },
      payload: {
        messageId: ids.message,
        conversationId: ids.conversation,
        targetBotIds: [ids.bot],
        messageKind: "user",
        automationDepth: 0,
      },
    });
    expect(JSON.stringify(event)).not.toContain("content");
  });

  test("rejects malformed envelopes and invalid message event variants", () => {
    expect(() =>
      parseDomainEventEnvelope({ type: "chat.message.sent", payload: {} }),
    ).toThrow();

    const event = createChatMessageSentV1({
      messageId: ids.message,
      conversationId: ids.conversation,
      targetBotIds: [],
      messageKind: "user",
      automationDepth: 0,
      senderId: ids.sender,
      senderType: "human",
    });
    expect(() => parseChatMessageSentV1({ ...event, version: 2 })).toThrow();
    expect(() =>
      parseChatMessageSentV1({
        ...event,
        actor: { id: ids.sender, type: "bot" },
      }),
    ).toThrow("user events require a human actor");
    expect(() =>
      parseChatMessageSentV1({
        ...event,
        payload: { ...event.payload, targetBotIds: [ids.bot, ids.bot] },
      }),
    ).toThrow("targetBotIds must be unique");
  });
});

describe("domain event registry", () => {
  test("dispatches registered handlers after envelope and event-specific validation", async () => {
    const handled: string[] = [];
    const registry = new DomainEventRegistry().register({
      type: "test.event",
      version: 1,
      parse(value) {
        const event = parseDomainEventEnvelope(value);
        if (event.type !== "test.event" || event.version !== 1) {
          throw new Error("unexpected event");
        }
        return event as DomainEventEnvelope & { type: "test.event"; version: 1 };
      },
      async handle(event) {
        handled.push(event.id);
      },
    });
    const event = parseDomainEventEnvelope({
      id: "44444444-4444-4444-8444-444444444444",
      type: "test.event",
      version: 1,
      aggregate: { type: "test", id: "one" },
      occurredAt: "2026-07-09T12:00:00.000Z",
      payload: {},
    });

    await expect(registry.dispatch(event)).resolves.toBe(true);
    expect(handled).toEqual([event.id]);
    await expect(registry.dispatch({ ...event, type: "another.event" })).resolves.toBe(false);
    await expect(
      registry.dispatch({ ...event, type: "another.event" }, { rejectMissing: true }),
    ).rejects.toBeInstanceOf(PermanentDomainEventError);
    await expect(registry.dispatch({ not: "an envelope" })).rejects.toBeInstanceOf(
      InvalidDomainEventError,
    );
  });

  test("classifies event-specific parse failures without hiding transient handler failures", async () => {
    const parseFailure = new Error("payload marker is invalid");
    const transientFailure = new Error("transient failure");
    const parseRegistry = new DomainEventRegistry().register<DomainEventEnvelope>({
      type: "test.invalid-payload",
      version: 1,
      parse() {
        throw parseFailure;
      },
      async handle() {
        throw new Error("handler must not run");
      },
    });
    const transientRegistry = new DomainEventRegistry().register({
      type: "test.transient",
      version: 1,
      parse: parseDomainEventEnvelope,
      async handle() {
        throw transientFailure;
      },
    });
    const invalid = parseDomainEventEnvelope({
      id: "55555555-5555-4555-8555-555555555555",
      type: "test.invalid-payload",
      version: 1,
      aggregate: { type: "test", id: "invalid" },
      occurredAt: "2026-07-09T12:00:00.000Z",
      payload: {},
    });
    const transient = parseDomainEventEnvelope({
      id: "66666666-6666-4666-8666-666666666666",
      type: "test.transient",
      version: 1,
      aggregate: { type: "test", id: "transient" },
      occurredAt: "2026-07-09T12:00:00.000Z",
      payload: {},
    });

    await expect(parseRegistry.dispatch(invalid)).rejects.toMatchObject({
      cause: parseFailure,
    });
    await expect(transientRegistry.dispatch(transient)).rejects.toBe(transientFailure);
  });
});

describe("outbox configuration and retry policy", () => {
  test("has a broker-free configuration with safe bounded defaults", () => {
    expect(loadDomainEventsConfig({
      DOMAIN_EVENTS_BATCH_SIZE: "12",
      DOMAIN_EVENTS_RETENTION_DAYS: "14",
    })).toMatchObject({
      batchSize: 12,
      retentionDays: 14,
      maxAttempts: 25,
    });
    expect(loadDomainEventsConfig({ DOMAIN_EVENTS_BATCH_SIZE: "0" }).batchSize).toBe(50);
  });

  test("backs off retries with a bounded delay", () => {
    expect([1, 2, 3, 20].map(retryDelayMs)).toEqual([
      1_000,
      2_000,
      4_000,
      60_000,
    ]);
  });
});
