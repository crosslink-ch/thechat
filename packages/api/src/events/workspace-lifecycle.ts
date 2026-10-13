import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { WsServerEvent } from "@thechat/shared";
import { db } from "../db";
import { eventOutbox } from "../db/schema";
import { publishWsEventToUsers } from "../realtime";
import { log } from "../logging";
import {
  domainEventEnvelopeSchema,
  type DomainEventEnvelope,
} from "./envelope";
import { enqueueDomainEvent } from "./outbox";
import type { DomainEventHandler } from "./registry";
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const staged = new AsyncLocalStorage<DomainEventEnvelope[]>();
export const WORKSPACE_LIFECYCLE_NOTIFICATION =
  "workspace.lifecycle.notification";
const schema = domainEventEnvelopeSchema.extend({
  type: z.literal(WORKSPACE_LIFECYCLE_NOTIFICATION),
  version: z.literal(1),
  payload: z.object({
    targetUserIds: z.array(z.string().uuid()),
    event: z.object({ type: z.string() }).passthrough(),
  }),
});

/** Same committed notification contract for REST, MCP and internal services. */
export async function stageLifecycleNotification(
  tx: Transaction,
  workspaceId: string,
  targetUserIds: string[],
  event: WsServerEvent,
) {
  const envelope: DomainEventEnvelope = {
    id: crypto.randomUUID(),
    type: WORKSPACE_LIFECYCLE_NOTIFICATION,
    version: 1,
    aggregate: { type: "workspace", id: workspaceId },
    tenant: { workspaceId },
    actor: { type: "system", id: "thechat" },
    occurredAt: new Date().toISOString(),
    payload: { targetUserIds: [...new Set(targetUserIds)], event },
  };
  await enqueueDomainEvent(tx, envelope, {
    partitionKey: `workspace-lifecycle:${workspaceId}`,
  });
  staged.getStore()?.push(envelope);
}
export async function lifecycleTransaction<T>(
  operation: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const events: DomainEventEnvelope[] = [];
  const result = await staged.run(events, () => db.transaction(operation));
  // Fast path preserves interactive delivery. Failure leaves durable outbox work
  // pending; it never turns a committed membership write into an ambiguous error.
  for (const event of events) {
    try {
      await publishNotification(event);
      await db
        .update(eventOutbox)
        .set({ publishedAt: new Date() })
        .where(
          and(
            eq(eventOutbox.id, event.id),
            isNull(eventOutbox.lockedBy),
            isNull(eventOutbox.publishedAt),
          ),
        );
    } catch (error) {
      log.warn(
        { err: error, eventId: event.id },
        "workspace.lifecycle.publish_pending",
      );
    }
  }
  return result;
}
async function publishNotification(event: DomainEventEnvelope) {
  const parsed = schema.parse(event);
  await publishWsEventToUsers(
    parsed.payload.targetUserIds,
    parsed.payload.event as WsServerEvent,
  );
}
export function createWorkspaceLifecycleNotificationHandler(): DomainEventHandler<DomainEventEnvelope> {
  return {
    type: WORKSPACE_LIFECYCLE_NOTIFICATION,
    version: 1,
    parse: (value) => schema.parse(value),
    handle: publishNotification,
  };
}
