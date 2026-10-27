import { withSpan } from "../observability";
import { parseDomainEventEnvelope, type DomainEventEnvelope } from "./envelope";
import { logDomainEvent } from "./log";

/**
 * Worker lanes have independent capacity. Slow storage work (attachment
 * validation and deletion) runs in its own lane so it can never occupy the
 * capacity that chat delivery and bot triggers need.
 */
export type DomainEventLane = "default" | "attachments";

export const DOMAIN_EVENT_LANES: readonly DomainEventLane[] = [
  "default",
  "attachments",
];

export interface DomainEventHandlerContext {
  /**
   * Aborted when the attempt's time budget is exhausted, the worker lost the
   * row's lease, or the worker is shutting down. Handlers should pass it to
   * any I/O they start.
   */
  signal: AbortSignal;
}

export interface DomainEventHandler<TEvent extends DomainEventEnvelope> {
  type: TEvent["type"];
  version: TEvent["version"];
  /** Defaults to "default". */
  lane?: DomainEventLane;
  parse(value: unknown): TEvent;
  /** The runtime always passes `context`; direct callers (tests) may omit it. */
  handle(event: TEvent, context?: DomainEventHandlerContext): Promise<void>;
}

export interface DomainEventDispatchOptions {
  rejectMissing?: boolean;
  signal?: AbortSignal;
}

export class InvalidDomainEventError extends Error {
  constructor(
    public readonly eventType: string,
    public readonly eventVersion: number,
    public readonly cause: unknown,
  ) {
    super(`Invalid payload for ${eventType} v${eventVersion}`);
  }
}

export class PermanentDomainEventError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
  }
}

const NEVER_ABORTED = new AbortController().signal;

export class DomainEventRegistry {
  private readonly handlers = new Map<
    string,
    DomainEventHandler<DomainEventEnvelope>
  >();

  register<TEvent extends DomainEventEnvelope>(
    handler: DomainEventHandler<TEvent>,
  ): this {
    const key = handlerKey(handler.type, handler.version);
    if (this.handlers.has(key)) {
      throw new Error(`Domain event handler already registered: ${key}`);
    }
    for (const existing of this.handlers.values()) {
      if (
        existing.type === handler.type &&
        (existing.lane ?? "default") !== (handler.lane ?? "default")
      ) {
        throw new Error(
          `All versions of ${handler.type} must use the same worker lane`,
        );
      }
    }
    this.handlers.set(
      key,
      handler as unknown as DomainEventHandler<DomainEventEnvelope>,
    );
    return this;
  }

  hasEventType(type: string): boolean {
    for (const handler of this.handlers.values()) {
      if (handler.type === type) return true;
    }
    return false;
  }

  supports(type: string, version: number): boolean {
    return this.handlers.has(handlerKey(type, version));
  }

  /** Event types whose handlers declared the given non-default lane. */
  eventTypesForLane(lane: Exclude<DomainEventLane, "default">): string[] {
    const types = new Set<string>();
    for (const handler of this.handlers.values()) {
      if (handler.lane === lane) types.add(handler.type);
    }
    return [...types].sort();
  }

  async dispatch(
    value: unknown,
    options: DomainEventDispatchOptions = {},
  ): Promise<boolean> {
    let event: DomainEventEnvelope;
    try {
      event = parseDomainEventEnvelope(value);
    } catch (error) {
      throw new InvalidDomainEventError("unknown", 0, error);
    }

    const handler = this.handlers.get(handlerKey(event.type, event.version));
    if (!handler) {
      logDomainEvent("info", "domain_event.skipped", event, {
        reason: "no_registered_handler",
      });
      if (options.rejectMissing) {
        throw new PermanentDomainEventError(
          `No handler registered for ${event.type} v${event.version}`,
        );
      }
      return false;
    }

    return withSpan(
      "domain_event.handle",
      {
        "messaging.system": "thechat-domain-events",
        "messaging.operation": "process",
        "messaging.message.type": event.type,
        "thechat.event.version": event.version,
        "thechat.aggregate.type": event.aggregate.type,
        "thechat.event.lane": handler.lane ?? "default",
      },
      async (span) => {
        let parsed: DomainEventEnvelope;
        try {
          parsed = handler.parse(event);
        } catch (error) {
          throw new InvalidDomainEventError(event.type, event.version, error);
        }
        logDomainEvent("info", "domain_event.handle.started", parsed);
        await handler.handle(parsed, {
          signal: options.signal ?? NEVER_ABORTED,
        });
        logDomainEvent("info", "domain_event.handle.completed", parsed);
        span.setAttribute("thechat.event.outcome", "handled");
        return true;
      },
      {
        recordException: false,
        errorAttributes: { "thechat.event.outcome": "failed" },
      },
    );
  }
}

function handlerKey(type: string, version: number) {
  return `${type}:v${version}`;
}
