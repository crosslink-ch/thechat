CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX "messages_content_search_idx" ON "messages" USING gin (lower("content") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "messages_context_order_idx" ON "messages" USING btree ("conversation_id","thread_id","created_at","id");