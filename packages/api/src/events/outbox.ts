import { sql } from "drizzle-orm";
import { SpanKind } from "@opentelemetry/api";
import { fromDrizzle } from "pg-boss";
import type { DomainEventEnvelope } from "./envelope";
import { activeTraceContext, withSpan } from "../observability";
import { eventQueue, getQueueClient, type Executor } from "../async/queue";

/** Transactional pg-boss producer. Pass the SAME transaction as the business write.
 * Kept at this import path to avoid churn in the domain services; no outbox relay remains.
 */
export async function enqueueDomainEvent(
  executor: Executor,
  event: DomainEventEnvelope,
  options: { partitionKey: string; availableAt?: Date },
) {
  return withSpan(
    "domain_event.enqueue",
    {
      "messaging.system": "pg-boss",
      "messaging.operation": "publish",
      "messaging.message.type": event.type,
      "thechat.aggregate.type": event.aggregate.type,
    },
    async (span) => {
      const traceContext = activeTraceContext();
      const boss = await getQueueClient();
      const queue = eventQueue(event.type);
      const sent = await boss.send(
        queue,
        traceContext ? { ...event, traceContext } : event,
        {
          id: event.id,
          ...(queue === "chat.message.sent"
            ? { singletonKey: options.partitionKey }
            : {}),
          ...(options.availableAt ? { startAfter: options.availableAt } : {}),
          db: fromDrizzle(executor, sql),
        },
      );
      if (
        !sent &&
        !(
          await boss.findJobs(queue, {
            id: event.id,
            db: fromDrizzle(executor, sql),
          })
        ).length
      )
        throw Error("Domain event was not durably inserted");
      span.setAttribute("thechat.queue.outcome", "staged");
    },
    { kind: SpanKind.PRODUCER },
  );
}
