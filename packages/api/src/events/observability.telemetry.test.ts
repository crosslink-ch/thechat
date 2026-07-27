import crypto from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { S3Client } from "@aws-sdk/client-s3";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { WsServerEvent } from "@thechat/shared";
import { S3ObjectStore } from "../attachments/s3-object-store";
import {
  contextFromTraceContext,
  setTracerForTests,
  withSpan,
} from "../observability";
import type { DomainEventEnvelope } from "./envelope";
import {
  enqueueDomainEvent,
  OUTBOX_SLOW_CLAIM_MS,
  traceOutboxClaimOperation,
  type ClaimedOutboxEvent,
} from "./outbox";
import { DomainEventRegistry } from "./registry";
import { processOutboxEventAttempt } from "./runtime";
import { deliverWebSocketEvent } from "../ws/delivery";

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

beforeAll(() => {
  provider.register();
  setTracerForTests(provider.getTracer("thechat-api-telemetry-test"));
});

afterEach(() => exporter.reset());

afterAll(async () => {
  setTracerForTests(null);
  await provider.shutdown();
});

describe("OpenTelemetry async-boundary contracts", () => {
  it("injects the outbox producer carrier and suppresses idle claim spans", async () => {
    let inserted: Record<string, unknown> | undefined;
    const executor = {
      insert: () => ({
        values: async (value: Record<string, unknown>) => {
          inserted = value;
        },
      }),
    };
    const event = testEvent();

    await withSpan("test.request", {}, () =>
      enqueueDomainEvent(executor as never, event, {
        partitionKey: `test:${event.id}`,
      }),
    );
    await flush();

    const producer = span("domain_event.outbox.enqueue");
    const request = span("test.request");
    const persistedEvent = inserted?.event as DomainEventEnvelope;
    expect(producer.kind).toBe(SpanKind.PRODUCER);
    expect(producer.parentSpanContext?.spanId).toBe(
      request.spanContext().spanId,
    );
    expect(persistedEvent.traceContext?.traceparent).toContain(
      producer.spanContext().spanId,
    );
    expect(producer.attributes["thechat.outbox.outcome"]).toBe("staged");

    exporter.reset();
    await traceOutboxClaimOperation(async () => [], {
      workerId: "test-worker",
      batchSize: 10,
      startedAt: new Date(),
    });
    await flush();
    expect(exporter.getFinishedSpans()).toHaveLength(0);

    await traceOutboxClaimOperation(async () => [testRow(persistedEvent)], {
      workerId: "test-worker",
      batchSize: 10,
      startedAt: new Date(),
    });
    await flush();
    const claimed = span("domain_event.outbox.claim");
    expect(claimed.kind).toBe(SpanKind.CLIENT);
    expect(claimed.attributes["thechat.outbox.claimed_count"]).toBe(1);
  });

  it("retains slow-empty and failed claim evidence without leaking raw errors", async () => {
    await traceOutboxClaimOperation(async () => [], {
      workerId: "test-worker",
      batchSize: 10,
      startedAt: new Date(Date.now() - OUTBOX_SLOW_CLAIM_MS - 10),
    });
    await flush();
    const slow = span("domain_event.outbox.claim");
    expect(slow.kind).toBe(SpanKind.CLIENT);
    expect(slow.attributes["thechat.outbox.claimed_count"]).toBe(0);
    expect(slow.attributes["thechat.outbox.outcome"]).toBe("slow_empty");
    expect(slow.status.code).toBe(SpanStatusCode.UNSET);

    exporter.reset();
    await expect(
      traceOutboxClaimOperation(
        async () => {
          throw new Error(
            "postgres://secret:password@db.invalid/thechat?token=never-export",
          );
        },
        {
          workerId: "test-worker",
          batchSize: 10,
          startedAt: new Date(),
        },
      ),
    ).rejects.toThrow();
    await flush();
    const failed = span("domain_event.outbox.claim");
    expect(failed.kind).toBe(SpanKind.CLIENT);
    expect(failed.attributes["thechat.outbox.claimed_count"]).toBe(0);
    expect(failed.attributes["thechat.outbox.outcome"]).toBe("error");
    expect(failed.status.code).toBe(SpanStatusCode.ERROR);
    expect(failed.events).toHaveLength(1);
    expect(JSON.stringify(failed.events)).not.toMatch(/secret|never-export/i);
  });

  it("keeps the consumer attempt open through fenced acknowledgement", async () => {
    let inserted: Record<string, unknown> | undefined;
    const executor = {
      insert: () => ({
        values: async (value: Record<string, unknown>) => {
          inserted = value;
        },
      }),
    };
    await enqueueDomainEvent(executor as never, testEvent(), {
      partitionKey: "test:ack",
    });
    await flush();
    const producer = span("domain_event.outbox.enqueue");
    const event = inserted?.event as DomainEventEnvelope;
    exporter.reset();

    const registry = new DomainEventRegistry().register({
      type: event.type,
      version: event.version,
      parse: (value) => value as DomainEventEnvelope,
      handle: async () => {},
    });
    let releaseAck!: (value: { kind: "published"; publishedAt: Date }) => void;
    let acknowledgeStarted!: () => void;
    const acknowledgementStarted = new Promise<void>((resolve) => {
      acknowledgeStarted = resolve;
    });
    const acknowledgement = new Promise<{
      kind: "published";
      publishedAt: Date;
    }>((resolve) => {
      releaseAck = resolve;
    });

    const processing = processOutboxEventAttempt(testRow(event), {
      registry,
      maxAttempts: 3,
      markPublished: async () => {
        acknowledgeStarted();
        return acknowledgement;
      },
    });
    await acknowledgementStarted;
    await flush();
    expect(
      exporter
        .getFinishedSpans()
        .filter((item) => item.name === "domain_event.outbox.consume"),
    ).toHaveLength(0);

    releaseAck({ kind: "published", publishedAt: new Date() });
    await processing;
    await flush();
    const consumer = span("domain_event.outbox.consume");
    expect(consumer.kind).toBe(SpanKind.CONSUMER);
    expect(consumer.parentSpanContext?.spanId).toBe(
      producer.spanContext().spanId,
    );
    expect(consumer.attributes["thechat.outbox.outcome"]).toBe("published");
    expect(consumer.status.code).toBe(SpanStatusCode.UNSET);
  });

  it("models retries as sibling attempts and records one sanitized exception per failure", async () => {
    let inserted: Record<string, unknown> | undefined;
    await enqueueDomainEvent(
      {
        insert: () => ({
          values: async (value: Record<string, unknown>) => {
            inserted = value;
          },
        }),
      } as never,
      testEvent(),
      { partitionKey: "test:retry" },
    );
    await flush();
    const producer = span("domain_event.outbox.enqueue");
    const event = inserted?.event as DomainEventEnvelope;
    exporter.reset();

    const registry = new DomainEventRegistry().register({
      type: event.type,
      version: event.version,
      parse: (value) => value as DomainEventEnvelope,
      handle: async () => {
        throw new Error(
          "https://signed.invalid/object?token=do-not-export filename=private.txt",
        );
      },
    });
    for (const attempts of [0, 1]) {
      await processOutboxEventAttempt(testRow(event, attempts), {
        registry,
        maxAttempts: 3,
        release: async () => ({
          kind: "released",
          attempts: attempts + 1,
          deadAt: null,
        }),
      });
    }
    await flush();

    const attempts = exporter
      .getFinishedSpans()
      .filter((item) => item.name === "domain_event.outbox.consume");
    expect(attempts).toHaveLength(2);
    expect(
      new Set(attempts.map((item) => item.parentSpanContext?.spanId)),
    ).toEqual(new Set([producer.spanContext().spanId]));
    for (const attempt of attempts) {
      expect(attempt.status.code).toBe(SpanStatusCode.ERROR);
      expect(attempt.attributes["thechat.outbox.outcome"]).toBe("released");
      expect(attempt.events).toHaveLength(1);
      expect(JSON.stringify(attempt.events)).not.toContain("do-not-export");
      expect(JSON.stringify(attempt.events)).not.toContain("private.txt");
    }
  });

  it("assigns bounded nested failure outcomes and records one leaf exception", async () => {
    let inserted: Record<string, unknown> | undefined;
    await enqueueDomainEvent(
      {
        insert: () => ({
          values: async (value: Record<string, unknown>) => {
            inserted = value;
          },
        }),
      } as never,
      testEvent(),
      { partitionKey: "test:storage-failure" },
    );
    await flush();
    const producer = span("domain_event.outbox.enqueue");
    const event = inserted?.event as DomainEventEnvelope;
    exporter.reset();

    const fakeClient = {
      send: async () => {
        throw new Error(
          "https://signed.invalid/object?token=do-not-export filename=private.txt",
        );
      },
    } as unknown as S3Client;
    const store = new S3ObjectStore({
      bucket: "synthetic-attachment-bucket",
      region: "eu-central-1",
      client: fakeClient,
    });
    const registry = new DomainEventRegistry().register({
      type: event.type,
      version: event.version,
      parse: (value) => value as DomainEventEnvelope,
      handle: async () => {
        await withSpan(
          "attachment.validate_promote",
          { "thechat.attachment_id": "synthetic-attachment" },
          () =>
            store.headObject({
              key: "quarantine/synthetic-attachment",
              versionId: "synthetic-version",
            }),
          { errorAttributes: { "thechat.attachment.outcome": "failed" } },
        );
      },
    });

    await processOutboxEventAttempt(testRow(event), {
      registry,
      maxAttempts: 3,
      release: async () => ({
        kind: "released",
        attempts: 1,
        deadAt: null,
      }),
    });
    await flush();

    const consumer = span("domain_event.outbox.consume");
    const handler = span("domain_event.handle");
    const attachment = span("attachment.validate_promote");
    const storage = span("attachment.s3.head");
    expect(consumer.parentSpanContext?.spanId).toBe(
      producer.spanContext().spanId,
    );
    expect(handler.parentSpanContext?.spanId).toBe(
      consumer.spanContext().spanId,
    );
    expect(attachment.parentSpanContext?.spanId).toBe(
      handler.spanContext().spanId,
    );
    expect(storage.parentSpanContext?.spanId).toBe(
      attachment.spanContext().spanId,
    );
    expect(consumer.attributes["thechat.outbox.outcome"]).toBe("released");
    expect(handler.attributes["thechat.event.outcome"]).toBe("failed");
    expect(attachment.attributes["thechat.attachment.outcome"]).toBe("failed");
    expect(storage.attributes["thechat.storage.outcome"]).toBe("failed");
    for (const failed of [consumer, handler, attachment, storage]) {
      expect(failed.status.code).toBe(SpanStatusCode.ERROR);
    }
    for (const failed of [handler, attachment, storage]) {
      expect(failed.attributes["thechat.operation.outcome"]).toBe("error");
    }
    expect(storage.events).toHaveLength(1);
    expect(handler.events).toHaveLength(0);
    expect(attachment.events).toHaveLength(0);
    expect(consumer.events).toHaveLength(0);
    expect(
      [consumer, handler, attachment, storage].reduce(
        (count, failed) => count + failed.events.length,
        0,
      ),
    ).toBe(1);
    expect(
      JSON.stringify(
        [consumer, handler, attachment, storage].map((failed) => ({
          attributes: failed.attributes,
          events: failed.events,
          status: failed.status,
        })),
      ),
    ).not.toMatch(/do-not-export|private\.txt|signed\.invalid/i);
  });

  it("dead-letters malformed envelopes instead of poisoning their partition", async () => {
    for (const invalidEvent of [null, {}, { aggregate: null }]) {
      exporter.reset();
      const malformed = { ...testRow(testEvent()), event: invalidEvent };
      let releaseCall:
        | { rowId: string; error: unknown; maxAttempts: number | undefined }
        | undefined;
      await processOutboxEventAttempt(malformed, {
        registry: new DomainEventRegistry(),
        maxAttempts: 25,
        release: async (row, error, _now, maxAttempts) => {
          releaseCall = { rowId: row.id, error, maxAttempts };
          return { kind: "dead", attempts: 1, deadAt: new Date() };
        },
      });
      await flush();

      expect(releaseCall?.rowId).toBe(malformed.id);
      expect(releaseCall?.maxAttempts).toBe(1);
      const consumer = span("domain_event.outbox.consume");
      expect(consumer.kind).toBe(SpanKind.CONSUMER);
      expect(consumer.attributes["thechat.outbox.outcome"]).toBe("dead");
      expect(consumer.status.code).toBe(SpanStatusCode.ERROR);
      expect(consumer.events).toHaveLength(1);
      expect(JSON.stringify(consumer.events)).not.toMatch(
        /postgres|password|token|payload/i,
      );
    }
  });

  it("injects a fresh WebSocket producer carrier consumed by the desktop hop", async () => {
    const outbound: string[] = [];
    await withSpan("realtime.receive", {}, async () => {
      const delivered = await deliverWebSocketEvent(
        {
          type: "new_message",
          message: {
            id: crypto.randomUUID(),
            conversationId: crypto.randomUUID(),
            content: "safe",
          },
          conversationType: "channel",
        } as unknown as WsServerEvent,
        [{ send: (data) => outbound.push(data) }],
      );
      expect(delivered.sent).toBe(1);
      const event = JSON.parse(outbound[0] ?? "{}") as {
        traceContext?: DomainEventEnvelope["traceContext"];
      };
      await withSpan("realtime.message.receive", {}, () => undefined, {
        kind: SpanKind.CONSUMER,
        parentContext: contextFromTraceContext(event.traceContext),
      });
    });
    await flush();

    const producer = span("realtime.websocket.send");
    const consumer = span("realtime.message.receive");
    expect(producer.kind).toBe(SpanKind.PRODUCER);
    expect(consumer.kind).toBe(SpanKind.CONSUMER);
    expect(consumer.parentSpanContext?.spanId).toBe(
      producer.spanContext().spanId,
    );
    expect(producer.attributes["realtime.delivery.outcome"]).toBe("delivered");
    const telemetryText = JSON.stringify(
      exporter.getFinishedSpans().map((item) => ({
        name: item.name,
        attributes: item.attributes,
        events: item.events,
        status: item.status,
      })),
    );
    expect(telemetryText).not.toMatch(
      /filename|checksum|signed\.invalid|do-not-export/i,
    );
  });
});

function testEvent(): DomainEventEnvelope {
  return {
    id: crypto.randomUUID(),
    type: "test.telemetry.event",
    version: 1,
    aggregate: { type: "test", id: crypto.randomUUID() },
    occurredAt: new Date().toISOString(),
    payload: {},
  };
}

function testRow(event: DomainEventEnvelope, attempts = 0): ClaimedOutboxEvent {
  const now = new Date();
  return {
    id: event.id,
    eventType: event.type,
    eventVersion: event.version,
    aggregateType: event.aggregate.type,
    aggregateId: event.aggregate.id,
    actorType: event.actor?.type ?? null,
    actorId: event.actor?.id ?? null,
    tenantId: event.tenant?.workspaceId ?? null,
    correlationId: event.correlationId ?? null,
    causationId: event.causationId ?? null,
    partitionKey: `test:${event.id}`,
    event,
    attempts,
    availableAt: now,
    lockedAt: now,
    lockedBy: "test-worker",
    publishedAt: null,
    deadAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function flush() {
  await provider.forceFlush();
}

function span(name: string) {
  const matches = exporter
    .getFinishedSpans()
    .filter((item) => item.name === name);
  expect(matches, `expected exactly one ${name} span`).toHaveLength(1);
  return matches[0]!;
}
