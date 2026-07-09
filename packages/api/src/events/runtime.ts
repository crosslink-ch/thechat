import crypto from "crypto";
import {
  Kafka,
  logLevel,
  Partitioners,
  type Consumer,
  type EachMessagePayload,
  type Producer,
} from "kafkajs";
import { withSpan } from "../observability";
import { loadDomainEventsConfig, type DomainEventsConfig } from "./config";
import { parseDomainEventEnvelope } from "./envelope";
import { processKafkaMessageAndCommit } from "./kafka-offsets";
import { logDomainEvent } from "./log";
import { createChatMessageSentHandler } from "./message-handler";
import {
  claimOutboxEvents,
  markOutboxEventPublished,
  releaseOutboxEvent,
  type ClaimedOutboxEvent,
} from "./outbox";
import {
  DomainEventRegistry,
  InvalidDomainEventError,
  PermanentDomainEventError,
} from "./registry";

export interface DomainEventRuntimeOptions {
  config?: DomainEventsConfig;
  registry?: DomainEventRegistry;
  workerId?: string;
}

export function createDefaultDomainEventRegistry() {
  return new DomainEventRegistry().register(createChatMessageSentHandler());
}

const KAFKA_DLQ_MAX_VALUE_BYTES = 256 * 1024;
const KAFKA_DLQ_MAX_KEY_BYTES = 1024;

export class DomainEventRuntime {
  private readonly config: DomainEventsConfig;
  private readonly registry: DomainEventRegistry;
  private readonly workerId: string;
  private readonly abortController = new AbortController();
  private producer: Producer | null = null;
  private consumer: Consumer | null = null;
  private relayPromise: Promise<void> | null = null;
  private consumerPromise: Promise<void> | null = null;
  private readonly failurePromise: Promise<Error>;
  private resolveFailure!: (error: Error) => void;
  private started = false;

  constructor(options: DomainEventRuntimeOptions = {}) {
    this.config = options.config ?? loadDomainEventsConfig();
    this.registry = options.registry ?? createDefaultDomainEventRegistry();
    this.workerId =
      options.workerId ??
      `${this.config.kafka.clientId}:${process.pid}:${crypto.randomUUID()}`;
    this.failurePromise = new Promise((resolve) => {
      this.resolveFailure = resolve;
    });
  }

  async start() {
    if (this.started) return;
    this.started = true;

    try {
      if (this.config.driver === "kafka") {
        await this.startKafka();
      }
      this.relayPromise = this.runOutboxRelay();
      logDomainEvent("info", "domain_event.runtime.started", undefined, {
        driver: this.config.driver,
        workerId: this.workerId,
        ...(this.config.driver === "kafka"
          ? {
              topic: this.config.kafka.topic,
              consumerGroup: this.config.kafka.consumerGroup,
              brokerCount: this.config.kafka.brokers.length,
            }
          : {}),
      });
    } catch (error) {
      this.started = false;
      await this.closeKafka();
      throw error;
    }
  }

  async close() {
    if (!this.started) return;
    this.started = false;
    this.abortController.abort();
    await this.consumer?.stop();
    await Promise.allSettled(
      [this.relayPromise, this.consumerPromise].filter(
        (promise): promise is Promise<void> => Boolean(promise),
      ),
    );
    await this.closeKafka();
    logDomainEvent("info", "domain_event.runtime.stopped", undefined, {
      driver: this.config.driver,
      workerId: this.workerId,
    });
  }

  async waitUntilFailed(): Promise<never> {
    throw await this.failurePromise;
  }

  private async startKafka() {
    const kafka = new Kafka({
      clientId: this.config.kafka.clientId,
      brokers: this.config.kafka.brokers,
      ssl: this.config.kafka.ssl,
      sasl: this.config.kafka.sasl
        ? kafkaSaslOptions(this.config.kafka.sasl)
        : undefined,
      logLevel: logLevel.WARN,
    });
    if (this.config.kafka.autoCreateTopics) {
      const admin = kafka.admin();
      await admin.connect();
      try {
        await admin.createTopics({
          waitForLeaders: true,
          topics: [
            {
              topic: this.config.kafka.topic,
              numPartitions: this.config.kafka.topicPartitions,
              replicationFactor: 1,
            },
            {
              topic: this.config.kafka.deadLetterTopic,
              numPartitions: this.config.kafka.topicPartitions,
              replicationFactor: 1,
            },
          ],
        });
      } finally {
        await admin.disconnect();
      }
    }
    this.producer = kafka.producer({
      allowAutoTopicCreation: false,
      createPartitioner: Partitioners.DefaultPartitioner,
    });
    this.consumer = kafka.consumer({
      groupId: this.config.kafka.consumerGroup,
      allowAutoTopicCreation: false,
    });
    await this.producer.connect();
    await this.consumer.connect();
    await this.consumer.subscribe({
      topic: this.config.kafka.topic,
      fromBeginning: this.config.kafka.fromBeginning,
    });
    this.consumer.on(this.consumer.events.CRASH, ({ payload }) => {
      if (this.abortController.signal.aborted) return;
      const failure =
        payload.error instanceof Error
          ? payload.error
          : new Error(String(payload.error));
      logDomainEvent("error", "domain_event.kafka.consumer_crashed", undefined, {
        error: failure.message,
        restart: payload.restart,
      });
      this.resolveFailure(failure);
    });
    this.consumerPromise = this.consumer
      .run({
        autoCommit: false,
        partitionsConsumedConcurrently: 1,
        eachMessage: (payload: EachMessagePayload) =>
          processKafkaMessageAndCommit(
            {
              topic: payload.topic,
              partition: payload.partition,
              offset: payload.message.offset,
            },
            () => this.consumeKafkaMessage(payload),
            (offsets) => this.consumer!.commitOffsets(offsets),
          ),
      })
      .catch((error: unknown) => {
        if (!this.abortController.signal.aborted) {
          const failure =
            error instanceof Error ? error : new Error(String(error));
          logDomainEvent("error", "domain_event.kafka.consumer_stopped", undefined, {
            error: failure.message,
          });
          this.resolveFailure(failure);
        }
      });
  }

  private async consumeKafkaMessage(payload: EachMessagePayload) {
    const { topic, partition, message } = payload;
    if (!message.value) {
      await this.deadLetterKafkaMessage(payload, "empty_value");
      return;
    }

    let event: ReturnType<typeof parseDomainEventEnvelope>;
    try {
      event = parseDomainEventEnvelope(
        JSON.parse(message.value.toString("utf8")),
      );
    } catch (error) {
      await this.deadLetterKafkaMessage(payload, "invalid_envelope", error);
      return;
    }

    if (!this.registry.supports(event.type, event.version)) {
      if (this.registry.hasEventType(event.type)) {
        await this.deadLetterKafkaMessage(
          payload,
          "unsupported_event_version",
          new Error(`No handler for ${event.type} v${event.version}`),
          event,
        );
      } else {
        logDomainEvent("info", "domain_event.kafka.message_skipped", event, {
          topic,
          partition,
          offset: message.offset,
          reason: "unregistered_event_type",
        });
      }
      return;
    }

    try {
      await withSpan(
        "domain_event.kafka.consume",
        {
          "messaging.system": "kafka",
          "messaging.operation": "receive",
          "messaging.destination.name": topic,
          "messaging.kafka.partition": partition,
          "messaging.kafka.message.offset": message.offset,
          "messaging.message.id": event.id,
          "messaging.message.type": event.type,
        },
        async () => {
          logDomainEvent("info", "domain_event.kafka.consumed", event, {
            topic,
            partition,
            offset: message.offset,
          });
          await this.registry.dispatch(event);
        },
      );
    } catch (error) {
      if (error instanceof InvalidDomainEventError) {
        await this.deadLetterKafkaMessage(
          payload,
          "invalid_event_payload",
          error,
          event,
        );
        return;
      }
      if (error instanceof PermanentDomainEventError) {
        await this.deadLetterKafkaMessage(
          payload,
          "permanent_handler_failure",
          error,
          event,
        );
        return;
      }
      throw error;
    }
  }

  private async deadLetterKafkaMessage(
    { topic, partition, message }: EachMessagePayload,
    reason: string,
    error?: unknown,
    event?: ReturnType<typeof parseDomainEventEnvelope>,
  ) {
    if (!this.producer) throw new Error("Kafka producer is not connected");
    const failedAt = new Date().toISOString();
    const originalValue = message.value ?? Buffer.alloc(0);
    const storedValue = originalValue.subarray(0, KAFKA_DLQ_MAX_VALUE_BYTES);
    const originalKey = message.key ?? Buffer.alloc(0);
    const storedKey = originalKey.subarray(0, KAFKA_DLQ_MAX_KEY_BYTES);
    await this.producer.send({
      topic: this.config.kafka.deadLetterTopic,
      messages: [
        {
          key: event?.aggregate.id || (storedKey.length > 0 ? storedKey : null),
          value: JSON.stringify({
            failedAt,
            reason,
            error: error ? errorMessage(error).slice(0, 2_000) : null,
            source: {
              topic,
              partition,
              offset: message.offset,
              timestamp: message.timestamp,
            },
            eventId: event?.id ?? null,
            eventType: event?.type ?? null,
            eventVersion: event?.version ?? null,
            keyBase64: storedKey.length > 0 ? storedKey.toString("base64") : null,
            keyBytes: originalKey.length,
            keyTruncated: originalKey.length > storedKey.length,
            valueBase64:
              storedValue.length > 0 ? storedValue.toString("base64") : null,
            valueBytes: originalValue.length,
            valueTruncated: originalValue.length > storedValue.length,
          }),
          headers: {
            "dead-letter-reason": reason,
            "source-topic": topic,
            "source-partition": String(partition),
            "source-offset": message.offset,
            ...(event
              ? {
                  "event-id": event.id,
                  "event-type": event.type,
                  "event-version": String(event.version),
                }
              : {}),
          },
        },
      ],
    });
    logDomainEvent("error", "domain_event.kafka.dead_lettered", event, {
      topic,
      deadLetterTopic: this.config.kafka.deadLetterTopic,
      partition,
      offset: message.offset,
      reason,
      error: error ? errorMessage(error) : undefined,
    });
  }

  private async runOutboxRelay() {
    const signal = this.abortController.signal;
    while (!signal.aborted) {
      try {
        const rows = await claimOutboxEvents({
          workerId: this.workerId,
          batchSize: this.config.batchSize,
          lockTimeoutMs: this.config.lockTimeoutMs,
        });
        if (rows.length === 0) {
          await waitForAbort(signal, this.config.pollIntervalMs);
          continue;
        }

        logDomainEvent("info", "domain_event.outbox.claimed", undefined, {
          driver: this.config.driver,
          workerId: this.workerId,
          count: rows.length,
        });
        await Promise.all(
          rows.map((row) => this.processOutboxEvent(row)),
        );
      } catch (error) {
        if (!signal.aborted) {
          logDomainEvent("error", "domain_event.outbox.claim_failed", undefined, {
            workerId: this.workerId,
            error: errorMessage(error),
          });
          await waitForAbort(signal, this.config.pollIntervalMs);
        }
      }
    }
  }

  private async processOutboxEvent(row: ClaimedOutboxEvent) {
    try {
      if (this.config.driver === "kafka") {
        await this.publishKafka(row);
      } else {
        await withSpan(
          "domain_event.outbox.consume",
          {
            "messaging.system": "postgresql-outbox",
            "messaging.operation": "process",
            "messaging.message.id": row.event.id,
            "messaging.message.type": row.event.type,
            "thechat.outbox.attempts": row.attempts,
          },
          () =>
            this.registry.dispatch(parseDomainEventEnvelope(row.event), {
              rejectMissing: true,
            }),
        );
      }
      await markOutboxEventPublished(row.id, row.lockedBy);
    } catch (error) {
      const permanent =
        error instanceof InvalidDomainEventError ||
        error instanceof PermanentDomainEventError;
      const released = await releaseOutboxEvent(
        row,
        error,
        new Date(),
        permanent ? 1 : this.config.maxAttempts,
      );
      logDomainEvent(
        released.deadAt ? "error" : "warn",
        released.deadAt
          ? "domain_event.outbox.dead_lettered"
          : "domain_event.outbox.processing_failed",
        row.event,
        {
          driver: this.config.driver,
          attempts: released.attempts,
          maxAttempts: this.config.maxAttempts,
          error: errorMessage(error),
        },
      );
    }
  }

  private async publishKafka(row: ClaimedOutboxEvent) {
    if (!this.producer) throw new Error("Kafka producer is not connected");
    await withSpan(
      "domain_event.kafka.publish",
      {
        "messaging.system": "kafka",
        "messaging.operation": "publish",
        "messaging.destination.name": this.config.kafka.topic,
        "messaging.message.id": row.event.id,
        "messaging.message.type": row.event.type,
        "messaging.kafka.message.key": row.partitionKey,
        "thechat.outbox.attempts": row.attempts,
      },
      async () => {
        await this.producer!.send({
          topic: this.config.kafka.topic,
          messages: [
            {
              key: row.partitionKey,
              value: JSON.stringify(row.event),
              headers: {
                "event-id": row.event.id,
                "event-type": row.event.type,
                "event-version": String(row.event.version),
              },
            },
          ],
        });
        logDomainEvent("info", "domain_event.kafka.published", row.event, {
          topic: this.config.kafka.topic,
          partitionKey: row.partitionKey,
        });
      },
    );
  }

  private async closeKafka() {
    await Promise.allSettled([
      this.consumer?.disconnect(),
      this.producer?.disconnect(),
    ]);
    this.consumer = null;
    this.producer = null;
    this.consumerPromise = null;
  }
}

let runtime: DomainEventRuntime | null = null;
let startPromise: Promise<DomainEventRuntime> | null = null;

export async function startDomainEventRuntime(
  options: DomainEventRuntimeOptions = {},
) {
  if (startPromise) return startPromise;
  startPromise = (async () => {
    const nextRuntime = new DomainEventRuntime(options);
    await nextRuntime.start();
    runtime = nextRuntime;
    return nextRuntime;
  })().catch((error) => {
    startPromise = null;
    throw error;
  });
  return startPromise;
}

export async function closeDomainEventRuntime() {
  const current = runtime;
  runtime = null;
  startPromise = null;
  await current?.close();
}

function waitForAbort(signal: AbortSignal, timeoutMs: number) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(done, timeoutMs);
    signal.addEventListener("abort", done, { once: true });

    function done() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof InvalidDomainEventError) {
    return `${error.message}: ${errorMessage(error.cause)}`;
  }
  if (error instanceof PermanentDomainEventError && error.cause) {
    return `${error.message}: ${errorMessage(error.cause)}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function kafkaSaslOptions(
  sasl: NonNullable<DomainEventsConfig["kafka"]["sasl"]>,
) {
  const credentials = {
    username: sasl.username,
    password: sasl.password,
  };
  switch (sasl.mechanism) {
    case "plain":
      return { mechanism: "plain" as const, ...credentials };
    case "scram-sha-256":
      return { mechanism: "scram-sha-256" as const, ...credentials };
    case "scram-sha-512":
      return { mechanism: "scram-sha-512" as const, ...credentials };
  }
}
