ALTER TABLE "bot_invocations" ADD COLUMN "hermes_session_json" jsonb;
ALTER TABLE "conversation_threads" ADD COLUMN "hermes_session_json" jsonb;
