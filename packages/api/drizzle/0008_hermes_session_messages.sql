ALTER TABLE "messages" ADD COLUMN "bot_session_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_bot_session_id_bot_sessions_id_fk" FOREIGN KEY ("bot_session_id") REFERENCES "public"."bot_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_bot_session_id_idx" ON "messages" USING btree ("bot_session_id");--> statement-breakpoint
DROP INDEX "public"."bot_sessions_bot_conversation_scope_idx";--> statement-breakpoint
CREATE INDEX "bot_sessions_bot_conversation_scope_idx" ON "bot_sessions" USING btree ("bot_id","conversation_id","scope");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_sessions_bot_conversation_scope_external_idx" ON "bot_sessions" USING btree ("bot_id","conversation_id","scope","external_session_id");--> statement-breakpoint
UPDATE "messages"
SET "bot_session_id" = "bot_invocations"."bot_session_id"
FROM "bot_invocations"
WHERE "messages"."id" = "bot_invocations"."trigger_message_id"
  AND "messages"."bot_session_id" IS NULL
  AND "bot_invocations"."bot_session_id" IS NOT NULL;--> statement-breakpoint
UPDATE "messages"
SET "bot_session_id" = "bot_invocations"."bot_session_id"
FROM "bot_invocations"
WHERE "messages"."id" = "bot_invocations"."response_message_id"
  AND "messages"."bot_session_id" IS NULL
  AND "bot_invocations"."bot_session_id" IS NOT NULL;
