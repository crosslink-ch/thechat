CREATE TABLE "bot_activity_snapshots" (
	"bot_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"origin_invocation_id" uuid NOT NULL,
	"thread_id" uuid,
	"requester_user_id" uuid,
	"session_id" varchar(255) NOT NULL,
	"snapshot" jsonb NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_activity_snapshots_bot_id_task_id_pk" PRIMARY KEY("bot_id","task_id")
);
--> statement-breakpoint
ALTER TABLE "bot_activity_snapshots" ADD CONSTRAINT "bot_activity_snapshots_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_activity_snapshots" ADD CONSTRAINT "bot_activity_snapshots_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bot_activity_conversation_idx" ON "bot_activity_snapshots" USING btree ("conversation_id","observed_at");