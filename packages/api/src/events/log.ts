import type { DomainEventEnvelope } from "./envelope";

type LogLevel = "info" | "warn" | "error";

export function logDomainEvent(
  level: LogLevel,
  message: string,
  event?: Pick<DomainEventEnvelope, "id" | "type" | "version" | "aggregate">,
  attributes: Record<string, unknown> = {},
) {
  const entry = {
    level,
    message,
    component: "domain-events",
    ...(event
      ? {
          eventId: event.id,
          eventType: event.type,
          eventVersion: event.version,
          aggregateType: event.aggregate.type,
          aggregateId: event.aggregate.id,
        }
      : {}),
    ...attributes,
  };
  console[level](JSON.stringify(entry));
}
