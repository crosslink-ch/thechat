DROP INDEX "event_outbox_pending_idx";--> statement-breakpoint
DROP INDEX "event_outbox_lock_idx";--> statement-breakpoint
DROP INDEX "event_outbox_partition_order_idx";--> statement-breakpoint
ALTER TABLE "event_outbox" ADD COLUMN "dead_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "event_outbox_pending_idx" ON "event_outbox" USING btree ("published_at","dead_at","available_at","created_at");--> statement-breakpoint
CREATE INDEX "event_outbox_lock_idx" ON "event_outbox" USING btree ("published_at","dead_at","locked_at");--> statement-breakpoint
CREATE INDEX "event_outbox_partition_order_idx" ON "event_outbox" USING btree ("partition_key","published_at","dead_at","created_at","id");