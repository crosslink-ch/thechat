ALTER TABLE "conversation_threads" ADD COLUMN "branch_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_threads" ADD COLUMN "branch_from_thread_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation_threads" ADD CONSTRAINT "conversation_threads_branch_from_thread_id_fk" FOREIGN KEY ("branch_from_thread_id") REFERENCES "public"."conversation_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_invocations" DROP COLUMN "hermes_session_json";--> statement-breakpoint
ALTER TABLE "conversation_threads" DROP COLUMN "hermes_session_json";
