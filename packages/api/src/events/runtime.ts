import crypto from "crypto";
import { SpanKind, SpanStatusCode, type Span } from "@opentelemetry/api";
import {
  contextFromTraceContext,
  recordSanitizedException,
  withSpan,
} from "../observability";
import { loadDomainEventsConfig, type DomainEventsConfig } from "./config";
import { logDomainEvent } from "./log";
import { createChatMessageSentHandler } from "./message-handler";
import {
  createAttachmentDeletionHandler,
  createAttachmentValidationHandler,
} from "../attachments/handler";
import {
  claimOutboxEvents,
  markOutboxEventPublished,
  prunePublishedOutboxEvents,
  releaseOutboxEvent,
  type ClaimedOutboxEvent,
} from "./outbox";
import type { DomainEventEnvelope } from "./envelope";
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
  return new DomainEventRegistry()
    .register(createChatMessageSentHandler())
    .register(createAttachmentValidationHandler())
    .register(createAttachmentDeletionHandler());
}

/**
 * Drains the transactional PostgreSQL outbox directly. It intentionally has no
 * broker dependency: API writes stay available while the worker retries after a
 * database or handler outage, and side effects are at-least-once.
 */
export class DomainEventRuntime {
  private readonly config: DomainEventsConfig;
  private readonly registry: DomainEventRegistry;
  private readonly workerId: string;
  private readonly abortController = new AbortController();
  private relayPromise: Promise<void> | null = null;
  private lastPruneAt = 0;
  private started = false;

  constructor(options: DomainEventRuntimeOptions = {}) {
    this.config = options.config ?? loadDomainEventsConfig();
    this.registry = options.registry ?? createDefaultDomainEventRegistry();
    this.workerId =
      options.workerId ??
      `thechat-outbox:${process.pid}:${crypto.randomUUID()}`;
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.relayPromise = this.runOutboxRelay();
    logDomainEvent("info", "domain_event.runtime.started", undefined, {
      workerId: this.workerId,
    });
  }

  async close() {
    if (!this.started) return;
    this.started = false;
    this.abortController.abort();
    await this.relayPromise;
    this.relayPromise = null;
    logDomainEvent("info", "domain_event.runtime.stopped", undefined, {
      workerId: this.workerId,
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
        if (rows.length > 0) {
          logDomainEvent("info", "domain_event.outbox.claimed", undefined, {
            workerId: this.workerId,
            count: rows.length,
          });
          await Promise.all(rows.map((row) => this.processOutboxEvent(row)));
        }
        await this.pruneIfDue();
        if (rows.length === 0) {
          await waitForAbort(signal, this.config.pollIntervalMs);
        }
      } catch (error) {
        if (!signal.aborted) {
          logDomainEvent(
            "error",
            "domain_event.outbox.claim_failed",
            undefined,
            {
              workerId: this.workerId,
              errorType: safeErrorType(error),
            },
          );
          await waitForAbort(signal, this.config.pollIntervalMs);
        }
      }
    }
  }

  private async processOutboxEvent(row: ClaimedOutboxEvent) {
    await processOutboxEventAttempt(row, {
      registry: this.registry,
      maxAttempts: this.config.maxAttempts,
    });
  }

  private async pruneIfDue() {
    const now = Date.now();
    if (now - this.lastPruneAt < this.config.pruneIntervalMs) return;
    const removed = await prunePublishedOutboxEvents({
      before: new Date(now - this.config.retentionDays * 86_400_000),
      batchSize: this.config.pruneBatchSize,
    });
    this.lastPruneAt = now;
    if (removed > 0) {
      logDomainEvent("info", "domain_event.outbox.pruned", undefined, {
        count: removed,
        retentionDays: this.config.retentionDays,
      });
    }
  }
}

export interface ProcessOutboxAttemptOptions {
  registry: DomainEventRegistry;
  maxAttempts: number;
  markPublished?: typeof markOutboxEventPublished;
  release?: typeof releaseOutboxEvent;
}

export async function processOutboxEventAttempt(
  row: ClaimedOutboxEvent,
  options: ProcessOutboxAttemptOptions,
) {
  const markPublished = options.markPublished ?? markOutboxEventPublished;
  const release = options.release ?? releaseOutboxEvent;
  const loggableEvent = loggableDomainEvent(row.event);

  await withSpan(
    "domain_event.outbox.consume",
    {
      "messaging.system": "postgresql-outbox",
      "messaging.operation": "process",
      "messaging.message.id": row.id,
      "messaging.message.type": row.eventType,
      "thechat.aggregate.type": row.aggregateType,
      "thechat.aggregate.id": row.aggregateId,
      "thechat.outbox.attempt": row.attempts + 1,
    },
    async (span) => {
      try {
        await options.registry.dispatch(row.event, { rejectMissing: true });
        const acknowledged = await markPublished(row.id, row.lockedBy);
        span.setAttribute("thechat.outbox.outcome", acknowledged.kind);
        if (acknowledged.kind === "lease_lost") {
          span.setStatus({ code: SpanStatusCode.ERROR });
          logDomainEvent(
            "warn",
            "domain_event.outbox.ack_lease_lost",
            loggableEvent,
            outboxLogContext(row),
          );
        }
        return;
      } catch (error) {
        const permanent =
          error instanceof InvalidDomainEventError ||
          error instanceof PermanentDomainEventError;
        const maxAttempts = permanent ? 1 : options.maxAttempts;
        let outcome: Awaited<ReturnType<typeof release>>;
        try {
          outcome = await release(row, error, new Date(), maxAttempts);
        } catch (releaseError) {
          recordAttemptFailure(span, releaseError, "release_failed");
          logDomainEvent(
            "error",
            "domain_event.outbox.release_failed",
            loggableEvent,
            {
              ...outboxLogContext(row),
              errorType: safeErrorType(releaseError),
            },
          );
          throw releaseError;
        }

        recordAttemptFailure(span, error, outcome.kind);
        if (outcome.kind === "lease_lost") {
          logDomainEvent(
            "warn",
            "domain_event.outbox.release_lease_lost",
            loggableEvent,
            {
              ...outboxLogContext(row),
              errorType: safeErrorType(error),
            },
          );
          return;
        }

        span.setAttribute("thechat.outbox.attempts", outcome.attempts);
        span.setAttribute("thechat.outbox.max_attempts", maxAttempts);
        logDomainEvent(
          outcome.kind === "dead" ? "error" : "warn",
          outcome.kind === "dead"
            ? "domain_event.outbox.dead_lettered"
            : "domain_event.outbox.processing_failed",
          loggableEvent,
          {
            ...outboxLogContext(row),
            attempts: outcome.attempts,
            maxAttempts,
            errorType: safeErrorType(error),
          },
        );
      }
    },
    {
      kind: SpanKind.CONSUMER,
      parentContext: contextFromTraceContext(traceContextFromUnknown(row.event)),
      recordException: false,
    },
  );
}

function traceContextFromUnknown(
  value: unknown,
): DomainEventEnvelope["traceContext"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as { traceContext?: unknown }).traceContext;
  if (!candidate || typeof candidate !== "object") return undefined;
  const traceparent = (candidate as { traceparent?: unknown }).traceparent;
  const tracestate = (candidate as { tracestate?: unknown }).tracestate;
  if (
    typeof traceparent !== "string" ||
    !/^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i.test(
      traceparent,
    )
  ) {
    return undefined;
  }
  return {
    traceparent,
    ...(typeof tracestate === "string" && tracestate.length <= 512
      ? { tracestate }
      : {}),
  };
}

function loggableDomainEvent(
  value: unknown,
): Pick<DomainEventEnvelope, "id" | "type" | "version" | "aggregate"> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const aggregate = candidate.aggregate;
  if (!aggregate || typeof aggregate !== "object") return undefined;
  const aggregateRecord = aggregate as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.type !== "string" ||
    typeof candidate.version !== "number" ||
    typeof aggregateRecord.type !== "string" ||
    typeof aggregateRecord.id !== "string"
  ) {
    return undefined;
  }
  return {
    id: candidate.id,
    type: candidate.type,
    version: candidate.version,
    aggregate: { type: aggregateRecord.type, id: aggregateRecord.id },
  };
}

function outboxLogContext(row: ClaimedOutboxEvent) {
  return {
    outboxId: row.id,
    workerId: row.lockedBy,
    eventType: row.eventType,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
  };
}

function recordAttemptFailure(span: Span, error: unknown, outcome: string) {
  span.setAttribute("thechat.outbox.outcome", outcome);
  recordSanitizedException(span, error);
  span.setStatus({ code: SpanStatusCode.ERROR });
}

function safeErrorType(error: unknown) {
  return error instanceof Error &&
    /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(error.name)
    ? error.name
    : "Error";
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
