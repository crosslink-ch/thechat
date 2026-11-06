-- Trigram operators for the content index below. pg_trgm is a trusted
-- extension: the database owner can create it without superuser.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_conversation_created_idx" ON "messages" USING btree ("conversation_id","created_at","id");--> statement-breakpoint
-- On a large table, build this first with CREATE INDEX CONCURRENTLY (see
-- docs/search.md); IF NOT EXISTS then makes this statement a no-op.
CREATE INDEX IF NOT EXISTS "messages_content_trgm_idx" ON "messages" USING gin ("content" gin_trgm_ops);