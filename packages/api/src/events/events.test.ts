import { describe, expect, test } from "bun:test";
import {
  CHAT_MESSAGE_SENT_EVENT_TYPE,
  createChatMessageSentV1,
  parseChatMessageSentV1,
  parseDomainEventEnvelope,
  type DomainEventEnvelope,
} from "./envelope";
import { loadDomainEventsConfig } from "./config";
import { DomainEventRegistry } from "./registry";
import { retryDelayMs } from "./retry";

const ids = {
  message: "11111111-1111-4111-8111-111111111111",
  sender: "33333333-3333-4333-8333-333333333333",
};

describe("domain event envelopes", () => {
  test("creates and parses the minimal chat.message.sent v1 envelope", () => {
    const event = createChatMessageSentV1({
      messageId: ids.message,
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
      payload: { messageId: ids.message },
    });
    expect(JSON.stringify(event)).not.toContain("content");
  });

  test("rejects malformed envelopes and wrong message event versions", () => {
    expect(() =>
      parseDomainEventEnvelope({ type: "chat.message.sent", payload: {} }),
    ).toThrow();

    const event = createChatMessageSentV1({
      messageId: ids.message,
      senderId: ids.sender,
      senderType: "human",
    });
    expect(() => parseChatMessageSentV1({ ...event, version: 2 })).toThrow();
    expect(() =>
      parseChatMessageSentV1({
        ...event,
        payload: { messageId: "99999999-9999-4999-8999-999999999999" },
      }),
    ).toThrow("messageId must match aggregate.id");
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
  });

  test("propagates handler failures for retry by the transport", async () => {
    const registry = new DomainEventRegistry().register({
      type: "test.failure",
      version: 1,
      parse: parseDomainEventEnvelope,
      async handle() {
        throw new Error("transient failure");
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

    await expect(registry.dispatch(event)).rejects.toThrow("transient failure");
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

  test("backs off retries with a bounded delay", () => {
    expect([1, 2, 3, 20].map(retryDelayMs)).toEqual([
      1_000,
      2_000,
      4_000,
      60_000,
    ]);
  });
});
