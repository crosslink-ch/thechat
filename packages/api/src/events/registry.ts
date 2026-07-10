import { withSpan } from "../observability";
import { parseDomainEventEnvelope, type DomainEventEnvelope } from "./envelope";
import { logDomainEvent } from "./log";

export interface DomainEventHandler<TEvent extends DomainEventEnvelope> {
  type: TEvent["type"];
  version: TEvent["version"];
  parse(value: unknown): TEvent;
  handle(event: TEvent): Promise<void>;
}

export interface DomainEventDispatchOptions {
  rejectMissing?: boolean;
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
        "messaging.message.id": event.id,
        "messaging.message.type": event.type,
        "thechat.event.version": event.version,
        "thechat.aggregate.type": event.aggregate.type,
        "thechat.aggregate.id": event.aggregate.id,
      },
      async () => {
        let parsed: DomainEventEnvelope;
        try {
          parsed = handler.parse(event);
        } catch (error) {
          throw new InvalidDomainEventError(event.type, event.version, error);
        }
        logDomainEvent("info", "domain_event.handle.started", parsed);
        await handler.handle(parsed);
        logDomainEvent("info", "domain_event.handle.completed", parsed);
        return true;
      },
    );
  }
}

function handlerKey(type: string, version: number) {
  return `${type}:v${version}`;
}
