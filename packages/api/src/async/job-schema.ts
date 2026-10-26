import { sql } from "drizzle-orm";
import {
  pgSchema,
  uuid,
  text,
  jsonb,
  timestamp,
  integer,
} from "drizzle-orm/pg-core";
/** Read/test mapping only. pg-boss owns this schema; exclude it from drizzle-kit. */
const table = pgSchema("pgboss").table("job", {
  id: uuid("id").notNull(),
  name: text("name").notNull(),
  event: jsonb("data"),
  state: text("state").notNull(),
  partitionKey: text("singleton_key"),
  attempts: integer("retry_count").notNull(),
  completedOn: timestamp("completed_on", { withTimezone: true }),
  createdAt: timestamp("created_on", { withTimezone: true }),
  output: jsonb("output"),
});
export const queueJobs = Object.assign(table, {
  eventType: sql<string>`${table.event}->>'type'`,
  aggregateId: sql<string>`${table.event}->'aggregate'->>'id'`,
  tenantId: sql<string>`${table.event}->'tenant'->>'workspaceId'`,
  actorId: sql<string>`${table.event}->'actor'->>'id'`,
});
