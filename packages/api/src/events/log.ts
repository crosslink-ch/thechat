import { log } from "../logging";
import type { DomainEventEnvelope } from "./envelope";

type LogLevel = "info" | "warn" | "error";

const domainEventLog = log.child({ component: "domain-events" });

export function logDomainEvent(
  level: LogLevel,
  message: string,
  event?: Pick<DomainEventEnvelope, "id" | "type" | "version" | "aggregate">,
  attributes: Record<string, unknown> = {},
) {
  const context = {
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
  domainEventLog[level](context, message);
}
