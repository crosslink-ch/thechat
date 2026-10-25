import crypto from "crypto";
import { SpanKind, SpanStatusCode, type Span } from "@opentelemetry/api";
import {
  contextFromTraceContext,
  recordSanitizedException,
  withSpan,
} from "../observability";
import {
  handlerBudgetMs,
  loadDomainEventsConfig,
  type DomainEventsConfig,
} from "./config";
import { logDomainEvent } from "./log";
import { createChatMessageSentHandler } from "./message-handler";
import { createBotRequestAnsweredHandler } from "../bot-requests/delivery";
import {
  createAttachmentDeletionHandler,
  createAttachmentValidationHandler,
} from "../attachments/handler";
import {
  claimOutboxEvents,
  countDeadOutboxEvents,
  handOffOutboxEvent,
  markOutboxEventPublished,
  prunePublishedOutboxEvents,
  releaseOutboxEvent,
  renewOutboxLeases,
  type ClaimedOutboxEvent,
  type OutboxEventTypeFilter,
} from "./outbox";
import type { DomainEventEnvelope } from "./envelope";
import {
  DomainEventRegistry,
  InvalidDomainEventError,
  PermanentDomainEventError,
  type DomainEventLane,
} from "./registry";
import {
  DomainEventHandlerAbandonedError,
  DomainEventHandlerTimeoutError,
  DomainEventLeaseLostError,
  DomainEventWorkerShutdownError,
} from "./abort";

export interface DomainEventRuntimeOptions {
  /** Overrides on top of the environment configuration. */
  config?: Partial<DomainEventsConfig>;
  registry?: DomainEventRegistry;
  workerId?: string;
}

export function createDefaultDomainEventRegistry() {
  return new DomainEventRegistry()
    .register(createChatMessageSentHandler())
    .register(createAttachmentValidationHandler())
    .register(createAttachmentDeletionHandler())
    .register(createBotRequestAnsweredHandler());
}

interface LaneState {
  name: DomainEventLane;
  capacity: number;
  baseTimeoutMs: number;
  filter: OutboxEventTypeFilter;
  inFlight: Set<string>;
  wakeup: Wakeup;
  loop: Promise<void> | null;
}

interface RunningJob {
  row: ClaimedOutboxEvent;
  controller: AbortController;
  done: Promise<void>;
}

/**
 * Drains the transactional PostgreSQL outbox directly. It intentionally has no
 * broker dependency: API writes stay available while the worker retries after a
 * database or handler outage, and side effects are at-least-once.
 *
 * Each lane keeps up to `capacity` handlers running and claims new rows as soon
 * as any handler finishes, so one slow event never holds back the next claim.
 * Lanes have separate capacity: attachment storage work cannot occupy the slots
 * that chat delivery and bot triggers use. Every attempt has a time budget that
 * doubles on retry, and the lease of a running row is renewed until it settles.
 */
export class DomainEventRuntime {
  private readonly config: DomainEventsConfig;
  private readonly registry: DomainEventRegistry;
  private readonly workerId: string;
  private readonly lanes: LaneState[];
  private readonly jobs = new Map<string, RunningJob>();
  private claimController = new AbortController();
  private heartbeatController = new AbortController();
  private heartbeatPromise: Promise<void> | null = null;
  private lastPruneAt = 0;
  private started = false;

  constructor(options: DomainEventRuntimeOptions = {}) {
    this.config = { ...loadDomainEventsConfig(), ...options.config };
    this.registry = options.registry ?? createDefaultDomainEventRegistry();
    this.workerId =
      options.workerId ??
      `thechat-outbox:${process.pid}:${crypto.randomUUID()}`;

    const attachmentTypes = this.registry.eventTypesForLane("attachments");
    this.lanes = [
      createLane(
        "default",
        this.config.batchSize,
        this.config.handlerTimeoutMs,
        attachmentTypes.length > 0 ? { exclude: attachmentTypes } : {},
      ),
    ];
    if (attachmentTypes.length > 0) {
      this.lanes.push(
        createLane(
          "attachments",
          this.config.attachmentConcurrency,
          this.config.attachmentHandlerTimeoutMs,
          { include: attachmentTypes },
        ),
      );
    }
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.claimController = new AbortController();
    this.heartbeatController = new AbortController();
    for (const lane of this.lanes) lane.loop = this.runLane(lane);
    this.heartbeatPromise = this.runHeartbeat();
    logDomainEvent("info", "domain_event.runtime.started", undefined, {
      workerId: this.workerId,
      lanes: Object.fromEntries(
        this.lanes.map((lane) => [lane.name, lane.capacity]),
      ),
    });
  }

  /**
   * Stop claiming, let running handlers finish for `shutdownGraceMs`, then
   * abort the rest and hand their rows back so another worker can take them
   * immediately without spending an attempt.
   */
  async close() {
    if (!this.started) return;
    this.started = false;
    this.claimController.abort();
    for (const lane of this.lanes) lane.wakeup.notify();
    await Promise.all(this.lanes.map((lane) => lane.loop));
    for (const lane of this.lanes) lane.loop = null;

    if (!(await this.waitForJobs(this.config.shutdownGraceMs))) {
      logDomainEvent("warn", "domain_event.runtime.shutdown_aborting", undefined, {
        workerId: this.workerId,
        running: this.jobs.size,
      });
      for (const job of this.jobs.values()) {
        job.controller.abort(new DomainEventWorkerShutdownError());
      }
      await this.waitForJobs(this.config.handlerAbortGraceMs + 1_000);
    }

    this.heartbeatController.abort();
    await this.heartbeatPromise;
    this.heartbeatPromise = null;
    logDomainEvent("info", "domain_event.runtime.stopped", undefined, {
      workerId: this.workerId,
      abandoned: this.jobs.size,
    });
  }

  private async runLane(lane: LaneState) {
    const signal = this.claimController.signal;
    while (!signal.aborted) {
      const free = lane.capacity - lane.inFlight.size;
      let claimed = 0;
      if (free > 0) {
        let rows: ClaimedOutboxEvent[];
        try {
          rows = await claimOutboxEvents({
            workerId: this.workerId,
            batchSize: free,
            lockTimeoutMs: this.config.lockTimeoutMs,
            eventTypes: lane.filter,
            lane: lane.name,
          });
        } catch (error) {
          if (signal.aborted) break;
          logDomainEvent("error", "domain_event.outbox.claim_failed", undefined, {
            workerId: this.workerId,
            lane: lane.name,
            errorType: safeErrorType(error),
          });
          await waitForAbort(signal, this.config.pollIntervalMs);
          continue;
        }
        if (signal.aborted) {
          // Shutdown began while the claim was in flight: give the rows back.
          await Promise.allSettled(rows.map((row) => handOffOutboxEvent(row)));
          break;
        }
        claimed = rows.length;
        if (rows.length > 0) {
          logDomainEvent("info", "domain_event.outbox.claimed", undefined, {
            workerId: this.workerId,
            lane: lane.name,
            count: rows.length,
          });
        }
        for (const row of rows) {
          // Only possible if our own lease expired while renewals failed; the
          // original handler is still running and now owns the fresh lease.
          if (this.jobs.has(row.id)) continue;
          this.startJob(lane, row);
        }
      }

      if (lane.name === "default") await this.pruneIfDue();
      if (signal.aborted) break;

      if (lane.inFlight.size >= lane.capacity) {
        // Full: claim again as soon as any handler in this lane finishes.
        await lane.wakeup.wait(signal, null);
      } else if (claimed < free) {
        // Drained for now: poll, but also wake when a handler finishes since
        // that may unblock the next event of its partition.
        await lane.wakeup.wait(signal, this.config.pollIntervalMs);
      }
    }
  }

  private startJob(lane: LaneState, row: ClaimedOutboxEvent) {
    const controller = new AbortController();
    const budgetMs = handlerBudgetMs(
      lane.baseTimeoutMs,
      this.config.maxHandlerTimeoutMs,
      row.attempts,
    );
    const timer = setTimeout(
      () => controller.abort(new DomainEventHandlerTimeoutError(budgetMs)),
      budgetMs,
    );
    const job: RunningJob = { row, controller, done: Promise.resolve() };
    lane.inFlight.add(row.id);
    this.jobs.set(row.id, job);
    job.done = processOutboxEventAttempt(row, {
      registry: this.registry,
      maxAttempts: this.config.maxAttempts,
      signal: controller.signal,
      abortGraceMs: this.config.handlerAbortGraceMs,
      lane: lane.name,
      budgetMs,
    })
      .catch((error) => {
        // The outcome could not be recorded (database unavailable). The row
        // stays leased; once renewals stop, another worker reclaims it after
        // `lockTimeoutMs`.
        logDomainEvent(
          "error",
          "domain_event.outbox.attempt_unrecorded",
          loggableDomainEvent(row.event),
          { ...outboxLogContext(row), errorType: safeErrorType(error) },
        );
      })
      .finally(() => {
        clearTimeout(timer);
        if (this.jobs.get(row.id) === job) this.jobs.delete(row.id);
        lane.inFlight.delete(row.id);
        lane.wakeup.notify();
      });
  }

  private async runHeartbeat() {
    const signal = this.heartbeatController.signal;
    const intervalMs = Math.max(50, Math.floor(this.config.lockTimeoutMs / 4));
    while (!signal.aborted) {
      await waitForAbort(signal, intervalMs);
      if (signal.aborted) break;
      const ids = [...this.jobs.keys()];
      if (ids.length === 0) continue;
      try {
        const renewed = await renewOutboxLeases(ids, this.workerId);
        for (const id of ids) {
          if (renewed.has(id)) continue;
          const job = this.jobs.get(id);
          if (!job || job.controller.signal.aborted) continue;
          job.controller.abort(new DomainEventLeaseLostError());
        }
      } catch (error) {
        logDomainEvent(
          "warn",
          "domain_event.outbox.lease_renewal_failed",
          undefined,
          {
            workerId: this.workerId,
            running: ids.length,
            errorType: safeErrorType(error),
          },
        );
      }
    }
  }

  private async waitForJobs(timeoutMs: number) {
    if (this.jobs.size === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = Promise.allSettled(
      [...this.jobs.values()].map((job) => job.done),
    ).then(() => true);
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([settled, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async pruneIfDue() {
    const now = Date.now();
    if (now - this.lastPruneAt < this.config.pruneIntervalMs) return;
    this.lastPruneAt = now;
    try {
      const removed = await prunePublishedOutboxEvents({
        before: new Date(now - this.config.retentionDays * 86_400_000),
        batchSize: this.config.pruneBatchSize,
      });
      if (removed > 0) {
        logDomainEvent("info", "domain_event.outbox.pruned", undefined, {
          count: removed,
          retentionDays: this.config.retentionDays,
        });
      }
      const dead = await countDeadOutboxEvents();
      if (dead > 0) {
        logDomainEvent(
          "warn",
          "domain_event.outbox.dead_letter_backlog",
          undefined,
          { count: dead },
        );
      }
    } catch (error) {
      logDomainEvent("warn", "domain_event.outbox.prune_failed", undefined, {
        workerId: this.workerId,
        errorType: safeErrorType(error),
      });
    }
  }
}

function createLane(
  name: DomainEventLane,
  capacity: number,
  baseTimeoutMs: number,
  filter: OutboxEventTypeFilter,
): LaneState {
  return {
    name,
    capacity: Math.max(1, capacity),
    baseTimeoutMs,
    filter,
    inFlight: new Set(),
    wakeup: new Wakeup(),
    loop: null,
  };
}

export interface ProcessOutboxAttemptOptions {
  registry: DomainEventRegistry;
  maxAttempts: number;
  /** Aborts the handler; its reason decides how the attempt is recorded. */
  signal?: AbortSignal;
  /** How long an aborted handler may take to stop before it is abandoned. */
  abortGraceMs?: number;
  lane?: DomainEventLane;
  budgetMs?: number;
  markPublished?: typeof markOutboxEventPublished;
  release?: typeof releaseOutboxEvent;
  handOff?: typeof handOffOutboxEvent;
}

export async function processOutboxEventAttempt(
  row: ClaimedOutboxEvent,
  options: ProcessOutboxAttemptOptions,
) {
  const markPublished = options.markPublished ?? markOutboxEventPublished;
  const release = options.release ?? releaseOutboxEvent;
  const handOff = options.handOff ?? handOffOutboxEvent;
  const loggableEvent = loggableDomainEvent(row.event);
  const signal = options.signal;
  const abortGraceMs = options.abortGraceMs ?? 5_000;

  await withSpan(
    "domain_event.outbox.consume",
    {
      "messaging.system": "postgresql-outbox",
      "messaging.operation": "process",
      "messaging.message.type": row.eventType,
      "thechat.aggregate.type": row.aggregateType,
      "thechat.outbox.attempt": row.attempts + 1,
      ...(options.lane ? { "thechat.event.lane": options.lane } : {}),
      ...(options.budgetMs
        ? { "thechat.outbox.budget_ms": options.budgetMs }
        : {}),
    },
    async (span) => {
      try {
        await settleUnlessAbandoned(
          options.registry.dispatch(row.event, { rejectMissing: true, signal }),
          signal,
          abortGraceMs,
        );
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
      } catch (thrown) {
        const interruption = signal?.aborted ? signal.reason : undefined;
        if (thrown instanceof DomainEventHandlerAbandonedError) {
          logDomainEvent("warn", "domain_event.handler.abandoned", loggableEvent, {
            ...outboxLogContext(row),
            graceMs: abortGraceMs,
            reason: safeErrorType(interruption),
          });
        }

        if (interruption instanceof DomainEventLeaseLostError) {
          recordAttemptFailure(span, interruption, "lease_lost");
          logDomainEvent(
            "warn",
            "domain_event.outbox.attempt_lease_lost",
            loggableEvent,
            outboxLogContext(row),
          );
          return;
        }

        if (interruption instanceof DomainEventWorkerShutdownError) {
          let handedOff = false;
          try {
            handedOff = await handOff(row);
          } catch (handOffError) {
            logDomainEvent(
              "warn",
              "domain_event.outbox.handoff_failed",
              loggableEvent,
              {
                ...outboxLogContext(row),
                errorType: safeErrorType(handOffError),
              },
            );
          }
          span.setAttribute(
            "thechat.outbox.outcome",
            handedOff ? "handed_off" : "handoff_skipped",
          );
          logDomainEvent(
            "info",
            "domain_event.outbox.handed_off",
            loggableEvent,
            { ...outboxLogContext(row), handedOff },
          );
          return;
        }

        const error =
          interruption instanceof DomainEventHandlerTimeoutError
            ? interruption
            : thrown;
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
            ...(error instanceof DomainEventHandlerTimeoutError
              ? { budgetMs: error.budgetMs }
              : {}),
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

/**
 * Resolve with the handler's result, but stop waiting `graceMs` after the
 * signal aborts. A handler that ignores its signal must not hold a lane slot
 * (or shutdown) forever.
 */
function settleUnlessAbandoned<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  graceMs: number,
): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      graceTimer = setTimeout(
        () => reject(new DomainEventHandlerAbandonedError(graceMs)),
        graceMs,
      );
    };
    const cleanup = () => {
      clearTimeout(graceTimer);
      signal.removeEventListener("abort", onAbort);
    };
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
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

/** Wakes a waiting lane loop early, e.g. when one of its handlers finishes. */
class Wakeup {
  private waiters: Array<() => void> = [];

  notify() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  /** Resolve on notify, abort, or after `timeoutMs` (never when null). */
  wait(signal: AbortSignal, timeoutMs: number | null) {
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timeout =
        timeoutMs === null ? undefined : setTimeout(done, timeoutMs);
      signal.addEventListener("abort", done, { once: true });
      this.waiters.push(done);

      function done() {
        clearTimeout(timeout);
        signal.removeEventListener("abort", done);
        resolve();
      }
    });
  }
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
