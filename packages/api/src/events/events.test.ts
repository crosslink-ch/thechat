import { describe, expect, test } from "bun:test";
import {
  CHAT_MESSAGE_SENT_EVENT_TYPE,
  createChatMessageSentV1,
  parseChatMessageSentV1,
  parseDomainEventEnvelope,
  type DomainEventEnvelope,
} from "./envelope";
import { loadDomainEventsConfig } from "./config";
import { DomainEventRegistry, InvalidDomainEventError } from "./registry";
import { retryDelayMs } from "./retry";
import { processKafkaMessageAndCommit } from "./kafka-offsets";

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

  test("rejects malformed envelopes and wrong message event versions", () => {
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
        payload: {
          ...event.payload,
          targetBotIds: [ids.bot, ids.bot],
        },
      }),
    ).toThrow("targetBotIds must be unique");
    expect(() =>
      parseChatMessageSentV1({
        ...event,
        payload: {
          ...event.payload,
          messageId: "99999999-9999-4999-8999-999999999999",
        },
      }),
    ).toThrow("payload.messageId must match aggregate.id");
  });
});

describe("domain event registry", () => {
  test("dispatches registered handlers only after event-specific parsing", async () => {
    const handled: string[] = [];
    const registry = new DomainEventRegistry().register({
      type: "test.event",
      version: 1,
      parse(value) {
        const event = parseDomainEventEnvelope(value);
        if (event.type !== "test.event" || event.version !== 1) {
          throw new Error("unexpected event");
        }
        return event as DomainEventEnvelope & {
          type: "test.event";
          version: 1;
        };
      },
      async handle(event) {
        await Promise.resolve();
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
    await expect(
      registry.dispatch({ ...event, type: "another.event" }),
    ).resolves.toBe(false);
    expect(registry.supports("test.event", 1)).toBe(true);
    expect(registry.hasEventType("test.event")).toBe(true);
    expect(registry.supports("test.event", 2)).toBe(false);
    await expect(
      registry.dispatch({ ...event, version: 2 }, { rejectMissing: true }),
    ).rejects.toThrow("No handler registered");
  });

  test("propagates handler failures for retry by the transport", async () => {
    const transientFailure = new Error("transient failure");
    const registry = new DomainEventRegistry().register({
      type: "test.failure",
      version: 1,
      parse: parseDomainEventEnvelope,
      async handle() {
        throw transientFailure;
      },
    });
    const event = parseDomainEventEnvelope({
      id: "55555555-5555-4555-8555-555555555555",
      type: "test.failure",
      version: 1,
      aggregate: { type: "test", id: "failure" },
      occurredAt: "2026-07-09T12:00:00.000Z",
      payload: {},
    });

    await expect(registry.dispatch(event)).rejects.toBe(transientFailure);
  });

  test("classifies only event-specific parse failures as invalid events", async () => {
    const parseFailure = new Error("payload marker is invalid");
    const registry = new DomainEventRegistry().register({
      type: "test.invalid-payload",
      version: 1,
      parse(): DomainEventEnvelope & {
        type: "test.invalid-payload";
        version: 1;
      } {
        throw parseFailure;
      },
      async handle() {
        throw new Error("handler must not run");
      },
    });
    const event = parseDomainEventEnvelope({
      id: "66666666-6666-4666-8666-666666666666",
      type: "test.invalid-payload",
      version: 1,
      aggregate: { type: "test", id: "invalid-payload" },
      occurredAt: "2026-07-09T12:00:00.000Z",
      payload: { marker: false },
    });

    const error = await registry.dispatch(event).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(InvalidDomainEventError);
    expect((error as InvalidDomainEventError).cause).toBe(parseFailure);
  });
});

describe("Kafka business offset handling", () => {
  test("commits the next offset only after successful processing", async () => {
    const steps: string[] = [];
    let committedOffsets: Array<{
      topic: string;
      partition: number;
      offset: string;
    }> = [];

    await processKafkaMessageAndCommit(
      { topic: "events", partition: 2, offset: "41" },
      async () => {
        steps.push("handled");
      },
      async (offsets) => {
        steps.push("committed");
        committedOffsets = offsets;
      },
    );

    expect(steps).toEqual(["handled", "committed"]);
    expect(committedOffsets).toEqual([
      { topic: "events", partition: 2, offset: "42" },
    ]);
  });

  test("does not commit processing failures and propagates commit failures", async () => {
    const processingFailure = new Error("database unavailable");
    let commitCalls = 0;
    await expect(
      processKafkaMessageAndCommit(
        { topic: "events", partition: 0, offset: "7" },
        async () => {
          throw processingFailure;
        },
        async () => {
          commitCalls += 1;
        },
      ),
    ).rejects.toBe(processingFailure);
    expect(commitCalls).toBe(0);

    const commitFailure = new Error("offset commit failed");
    let processCalls = 0;
    await expect(
      processKafkaMessageAndCommit(
        { topic: "events", partition: 0, offset: "7" },
        async () => {
          processCalls += 1;
        },
        async () => {
          throw commitFailure;
        },
      ),
    ).rejects.toBe(commitFailure);
    expect(processCalls).toBe(1);
  });
});

describe("domain event configuration and retries", () => {
  test("defaults to the broker-free outbox driver", () => {
    expect(
      loadDomainEventsConfig({ KAFKA_SASL_MECHANISM: "plain" }).driver,
    ).toBe("outbox");
  });

  test("fails clearly when kafka is selected without brokers", () => {
    expect(() =>
      loadDomainEventsConfig({ DOMAIN_EVENTS_DRIVER: "kafka" }),
    ).toThrow("KAFKA_BROKERS is required");
  });

  test("requires the Kafka main and dead-letter topics to differ", () => {
    expect(() =>
      loadDomainEventsConfig({
        DOMAIN_EVENTS_DRIVER: "kafka",
        KAFKA_BROKERS: "broker:9092",
        KAFKA_TOPIC: "same-topic",
        KAFKA_DEAD_LETTER_TOPIC: "same-topic",
      }),
    ).toThrow("KAFKA_DEAD_LETTER_TOPIC must differ");
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
