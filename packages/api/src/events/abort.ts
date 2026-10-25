/**
 * Reasons the worker aborts a running domain-event handler. They are set as
 * `AbortSignal.reason`, so the runtime can tell a timeout (counts as a failed
 * attempt) from a lost lease (another worker owns the row) or a shutdown (the
 * row is handed back without spending an attempt).
 */

export class DomainEventHandlerTimeoutError extends Error {
  constructor(public readonly budgetMs: number) {
    super(`Handler exceeded its ${budgetMs} ms attempt budget`);
    this.name = "DomainEventHandlerTimeoutError";
  }
}

export class DomainEventLeaseLostError extends Error {
  constructor() {
    super("Outbox lease was lost to another worker");
    this.name = "DomainEventLeaseLostError";
  }
}

export class DomainEventWorkerShutdownError extends Error {
  constructor() {
    super("Worker is shutting down");
    this.name = "DomainEventWorkerShutdownError";
  }
}

/** The handler ignored its abort signal for longer than the grace period. */
export class DomainEventHandlerAbandonedError extends Error {
  constructor(public readonly graceMs: number) {
    super(`Handler did not stop within ${graceMs} ms of being aborted`);
    this.name = "DomainEventHandlerAbandonedError";
  }
}
