import type { DomainEventEnvelope } from "./envelope";
import { logDomainEvent } from "./log";
import { withSpan } from "../observability";

export interface DomainEventHandler<TEvent extends DomainEventEnvelope> {
  type: TEvent["type"];
  version: TEvent["version"];
  parse(value: unknown): TEvent;
  handle(event: TEvent): Promise<void>;
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

  async dispatch(event: DomainEventEnvelope): Promise<boolean> {
    const handler = this.handlers.get(handlerKey(event.type, event.version));
    if (!handler) {
      logDomainEvent("info", "domain_event.skipped", event, {
        reason: "no_registered_handler",
      });
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
        const parsed = handler.parse(event);
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
