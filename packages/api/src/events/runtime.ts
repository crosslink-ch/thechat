import crypto from "crypto";
import { withSpan } from "../observability";
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
    this.workerId = options.workerId ?? `thechat-outbox:${process.pid}:${crypto.randomUUID()}`;
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
          logDomainEvent("error", "domain_event.outbox.claim_failed", undefined, {
            workerId: this.workerId,
            err: error,
            error: errorMessage(error),
          });
          await waitForAbort(signal, this.config.pollIntervalMs);
        }
      }
    }
  }

  private async processOutboxEvent(row: ClaimedOutboxEvent) {
    try {
      await withSpan(
        "domain_event.outbox.consume",
        {
          "messaging.system": "postgresql-outbox",
          "messaging.operation": "process",
          "messaging.message.id": row.id,
          "thechat.outbox.attempts": row.attempts,
        },
        () => this.registry.dispatch(row.event, { rejectMissing: true }),
      );
      const acknowledged = await markOutboxEventPublished(row.id, row.lockedBy);
      if (acknowledged.kind === "lease_lost") {
        logDomainEvent("warn", "domain_event.outbox.ack_lease_lost", undefined, {
          outboxId: row.id,
          workerId: row.lockedBy,
        });
      }
    } catch (error) {
      const permanent =
        error instanceof InvalidDomainEventError ||
        error instanceof PermanentDomainEventError;
      const outcome = await releaseOutboxEvent(
        row,
        error,
        new Date(),
        permanent ? 1 : this.config.maxAttempts,
      );
      if (outcome.kind === "lease_lost") {
        logDomainEvent("warn", "domain_event.outbox.release_lease_lost", undefined, {
          outboxId: row.id,
          workerId: row.lockedBy,
          err: error,
          error: errorMessage(error),
        });
        return;
      }
      logDomainEvent(
        outcome.kind === "dead" ? "error" : "warn",
        outcome.kind === "dead"
          ? "domain_event.outbox.dead_lettered"
          : "domain_event.outbox.processing_failed",
        undefined,
        {
          outboxId: row.id,
          attempts: outcome.attempts,
          maxAttempts: permanent ? 1 : this.config.maxAttempts,
          err: error,
          error: errorMessage(error),
        },
      );
    }
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
