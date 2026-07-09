import { afterAll, expect, test } from "bun:test";
import crypto from "crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { eventOutbox } from "../db/schema";
import { loadDomainEventsConfig } from "./config";
import { parseDomainEventEnvelope } from "./envelope";
import { enqueueDomainEvent } from "./outbox";
import { DomainEventRegistry } from "./registry";
import { DomainEventRuntime } from "./runtime";

const hasKafka = Boolean(process.env.KAFKA_BROKERS?.trim());
const kafkaTest = hasKafka ? test : test.skip;
const eventIds: string[] = [];

afterAll(async () => {
  if (eventIds.length > 0) {
    await db.delete(eventOutbox).where(inArray(eventOutbox.id, eventIds));
  }
});

kafkaTest(
  "relays a real outbox event through Kafka and handles it after consumption",
  async () => {
    const suffix = crypto.randomUUID();
    const topic = `thechat.domain-events.integration.${suffix}`;
    const handled: string[] = [];
    const registry = new DomainEventRegistry().register({
      type: "test.kafka.roundtrip",
      version: 1,
      parse: parseDomainEventEnvelope,
      async handle(event) {
        handled.push(event.id);
      },
    });
    const config = loadDomainEventsConfig({
      ...process.env,
      DOMAIN_EVENTS_DRIVER: "kafka",
      KAFKA_TOPIC: topic,
      KAFKA_CONSUMER_GROUP: `thechat-integration-${suffix}`,
      KAFKA_CLIENT_ID: `thechat-integration-${suffix}`,
      KAFKA_AUTO_CREATE_TOPICS: "true",
      KAFKA_TOPIC_PARTITIONS: "3",
      KAFKA_FROM_BEGINNING: "true",
      DOMAIN_EVENTS_POLL_INTERVAL_MS: "25",
    });
    const runtime = new DomainEventRuntime({ config, registry });
    const event = parseDomainEventEnvelope({
      id: crypto.randomUUID(),
      type: "test.kafka.roundtrip",
      version: 1,
      aggregate: { type: "integration_test", id: suffix },
      correlationId: suffix,
      occurredAt: new Date().toISOString(),
      payload: { marker: suffix },
    });
    eventIds.push(event.id);

    await runtime.start();
    try {
      await enqueueDomainEvent(db, event, { partitionKey: suffix });
      await waitFor(async () => {
        if (!handled.includes(event.id)) return false;
        const [row] = await db
          .select({ publishedAt: eventOutbox.publishedAt })
          .from(eventOutbox)
          .where(eq(eventOutbox.id, event.id));
        return row?.publishedAt instanceof Date;
      }, 20_000);

      const [row] = await db
        .select({ publishedAt: eventOutbox.publishedAt })
        .from(eventOutbox)
        .where(eq(eventOutbox.id, event.id));
      expect(row.publishedAt).toBeInstanceOf(Date);
      expect(handled).toEqual([event.id]);
    } finally {
      await runtime.close();
    }
  },
  30_000,
);

kafkaTest(
  "propagates a Kafka consumer crash to the worker supervisor",
  async () => {
    const suffix = crypto.randomUUID();
    const expectedFailure = `intentional consumer failure ${suffix}`;
    const registry = new DomainEventRegistry().register({
      type: "test.kafka.failure",
      version: 1,
      parse: parseDomainEventEnvelope,
      async handle() {
        throw new Error(expectedFailure);
      },
    });
    const config = loadDomainEventsConfig({
      ...process.env,
      DOMAIN_EVENTS_DRIVER: "kafka",
      KAFKA_TOPIC: `thechat.domain-events.integration.${suffix}`,
      KAFKA_CONSUMER_GROUP: `thechat-integration-${suffix}`,
      KAFKA_CLIENT_ID: `thechat-integration-${suffix}`,
      KAFKA_AUTO_CREATE_TOPICS: "true",
      KAFKA_TOPIC_PARTITIONS: "3",
      KAFKA_FROM_BEGINNING: "true",
      DOMAIN_EVENTS_POLL_INTERVAL_MS: "25",
    });
    const runtime = new DomainEventRuntime({ config, registry });
    const event = parseDomainEventEnvelope({
      id: crypto.randomUUID(),
      type: "test.kafka.failure",
      version: 1,
      aggregate: { type: "integration_test", id: suffix },
      occurredAt: new Date().toISOString(),
      payload: {},
    });
    eventIds.push(event.id);

    await runtime.start();
    try {
      await enqueueDomainEvent(db, event, { partitionKey: suffix });
      const failure = await Promise.race([
        runtime.waitUntilFailed().catch((error: unknown) =>
          error instanceof Error ? error : new Error(String(error)),
        ),
        Bun.sleep(20_000).then(
          () => new Error("Timed out waiting for Kafka consumer crash"),
        ),
      ]);
      expect(failure.message).toBe(expectedFailure);
    } finally {
      await runtime.close();
    }
  },
  30_000,
);

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(50);
  }
  throw new Error("Timed out waiting for Kafka round trip");
}
