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
import { logDomainEvent } from "./log";
import { createChatMessageSentHandler } from "./message-handler";
import {
  claimOutboxEvents,
  markOutboxEventPublished,
  releaseOutboxEvent,
  type ClaimedOutboxEvent,
} from "./outbox";
import { DomainEventRegistry } from "./registry";

export interface DomainEventRuntimeOptions {
  config?: DomainEventsConfig;
  registry?: DomainEventRegistry;
  workerId?: string;
}

export function createDefaultDomainEventRegistry() {
  return new DomainEventRegistry().register(createChatMessageSentHandler());
}

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
        eachMessage: (payload: EachMessagePayload) =>
          this.consumeKafkaMessage(payload),
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

  private async consumeKafkaMessage({
    topic,
    partition,
    message,
  }: EachMessagePayload) {
    if (!message.value) {
      logDomainEvent("warn", "domain_event.kafka.message_skipped", undefined, {
        topic,
        partition,
        offset: message.offset,
        reason: "empty_value",
      });
      return;
    }

    let event;
    try {
      event = parseDomainEventEnvelope(
        JSON.parse(message.value.toString("utf8")),
      );
    } catch (error) {
      logDomainEvent("warn", "domain_event.kafka.message_skipped", undefined, {
        topic,
        partition,
        offset: message.offset,
        reason: "invalid_envelope",
        error: errorMessage(error),
      });
      return;
    }

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
        // KafkaJS only advances this message after this callback resolves. A
        // transient handler failure is rethrown so the consumer retries it.
        await this.registry.dispatch(event);
      },
    );
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
        for (const row of rows) {
          await this.processOutboxEvent(row);
        }
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
          () => this.registry.dispatch(parseDomainEventEnvelope(row.event)),
        );
      }
      await markOutboxEventPublished(row.id, row.lockedBy);
    } catch (error) {
      await releaseOutboxEvent(row, error);
      logDomainEvent("error", "domain_event.outbox.processing_failed", row.event, {
        driver: this.config.driver,
        attempts: row.attempts + 1,
        error: errorMessage(error),
      });
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

function errorMessage(error: unknown) {
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
