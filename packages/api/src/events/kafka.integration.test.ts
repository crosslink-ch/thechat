import { afterAll, expect, test } from "bun:test";
import crypto from "crypto";
import { eq, inArray } from "drizzle-orm";
import { Kafka, type EachMessagePayload } from "kafkajs";
import { db } from "../db";
import { eventOutbox } from "../db/schema";
import { loadDomainEventsConfig } from "./config";
import { parseDomainEventEnvelope } from "./envelope";
import { enqueueDomainEvent } from "./outbox";
import { DomainEventRegistry, PermanentDomainEventError } from "./registry";
import { DomainEventRuntime } from "./runtime";

const runKafkaIntegration = process.env.RUN_KAFKA_INTEGRATION === "1";
const hasKafkaBrokers = Boolean(process.env.KAFKA_BROKERS?.trim());
if (runKafkaIntegration && !hasKafkaBrokers) {
  throw new Error(
    "RUN_KAFKA_INTEGRATION=1 requires a non-empty KAFKA_BROKERS value",
  );
}
const kafkaTest = runKafkaIntegration && hasKafkaBrokers ? test : test.skip;
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

kafkaTest(
  "dead-letters malformed Kafka records before acknowledging them",
  async () => {
    const suffix = crypto.randomUUID();
    const topic = `thechat.domain-events.integration.${suffix}`;
    const config = loadDomainEventsConfig({
      ...process.env,
      DOMAIN_EVENTS_DRIVER: "kafka",
      KAFKA_TOPIC: topic,
      KAFKA_DEAD_LETTER_TOPIC: `${topic}.dlq`,
      KAFKA_CONSUMER_GROUP: `thechat-integration-${suffix}`,
      KAFKA_CLIENT_ID: `thechat-integration-${suffix}`,
      KAFKA_AUTO_CREATE_TOPICS: "true",
      KAFKA_TOPIC_PARTITIONS: "1",
      KAFKA_FROM_BEGINNING: "true",
      DOMAIN_EVENTS_POLL_INTERVAL_MS: "25",
    });
    const registry = new DomainEventRegistry();
    registry.register({
      type: "test.versioned",
      version: 1,
      parse: (event) => {
        const parsed = parseDomainEventEnvelope(event);
        if ((parsed.payload as { valid?: unknown }).valid !== true) {
          throw new Error("payload.valid must be true");
        }
        return parsed;
      },
      handle: async () => undefined,
    });
    registry.register({
      type: "test.permanent",
      version: 1,
      parse: parseDomainEventEnvelope,
      handle: async () => {
        throw new PermanentDomainEventError("canonical aggregate is gone");
      },
    });
    const runtime = new DomainEventRuntime({
      config,
      registry,
    });
    const kafka = new Kafka({
      clientId: `thechat-dlq-test-${suffix}`,
      brokers: config.kafka.brokers,
      ssl: config.kafka.ssl,
      sasl: testKafkaSasl(config.kafka.sasl),
    });
    const producer = kafka.producer({ allowAutoTopicCreation: false });
    const dlqConsumer = kafka.consumer({
      groupId: `thechat-dlq-observer-${suffix}`,
      allowAutoTopicCreation: false,
    });

    await runtime.start();
    try {
      await producer.connect();
      await dlqConsumer.connect();
      await dlqConsumer.subscribe({
        topic: config.kafka.deadLetterTopic,
        fromBeginning: true,
      });
      const deadLetters = new Promise<Record<string, unknown>[]>((resolve) => {
        const records: Record<string, unknown>[] = [];
        void dlqConsumer.run({
          eachMessage: async ({ message }: EachMessagePayload) => {
            if (!message.value) return;
            records.push(JSON.parse(message.value.toString("utf8")));
            if (records.length === 4) resolve(records);
          },
        });
      });
      await producer.send({
        topic,
        messages: [
          { key: suffix, value: "not-json" },
          {
            key: suffix,
            value: JSON.stringify({
              id: crypto.randomUUID(),
              type: "test.versioned",
              version: 2,
              occurredAt: new Date().toISOString(),
              aggregate: { type: "test", id: suffix },
              payload: {},
            }),
          },
          {
            key: suffix,
            value: JSON.stringify({
              id: crypto.randomUUID(),
              type: "test.versioned",
              version: 1,
              occurredAt: new Date().toISOString(),
              aggregate: { type: "test", id: suffix },
              payload: { valid: false },
            }),
          },
          {
            key: suffix,
            value: JSON.stringify({
              id: crypto.randomUUID(),
              type: "test.permanent",
              version: 1,
              occurredAt: new Date().toISOString(),
              aggregate: { type: "test", id: suffix },
              payload: {},
            }),
          },
        ],
      });

      const records = await Promise.race([
        deadLetters,
        Bun.sleep(20_000).then(() => {
          throw new Error("Timed out waiting for Kafka dead letters");
        }),
      ]);
      expect(records.map((record) => record.reason).sort()).toEqual([
        "invalid_envelope",
        "invalid_event_payload",
        "permanent_handler_failure",
        "unsupported_event_version",
      ]);
      expect(records.every((record) => record.valueTruncated === false)).toBe(
        true,
      );
      expect(records.every((record) => {
        const source = record.source as { topic?: string } | undefined;
        return source?.topic === topic;
      })).toBe(true);
    } finally {
      await dlqConsumer.disconnect();
      await producer.disconnect();
      await runtime.close();
    }
  },
  30_000,
);

function testKafkaSasl(
  sasl: ReturnType<typeof loadDomainEventsConfig>["kafka"]["sasl"],
) {
  if (!sasl) return undefined;
  const credentials = { username: sasl.username, password: sasl.password };
  switch (sasl.mechanism) {
    case "plain":
      return { mechanism: "plain" as const, ...credentials };
    case "scram-sha-256":
      return { mechanism: "scram-sha-256" as const, ...credentials };
    case "scram-sha-512":
      return { mechanism: "scram-sha-512" as const, ...credentials };
  }
}

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
