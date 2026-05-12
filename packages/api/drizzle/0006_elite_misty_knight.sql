CREATE TABLE "bot_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invocation_id" uuid NOT NULL,
	"type" varchar(100) NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_invocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_session_id" uuid,
	"bot_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"trigger_message_id" uuid NOT NULL,
	"response_message_id" uuid,
	"adapter_kind" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"external_run_id" text,
	"request_json" jsonb,
	"response_json" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"workspace_id" varchar(100),
	"conversation_id" uuid,
	"scope" varchar(20) DEFAULT 'conversation' NOT NULL,
	"external_session_id" text,
	"title" text,
	"last_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot_events" ADD CONSTRAINT "bot_events_invocation_id_bot_invocations_id_fk" FOREIGN KEY ("invocation_id") REFERENCES "public"."bot_invocations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_invocations" ADD CONSTRAINT "bot_invocations_bot_session_id_bot_sessions_id_fk" FOREIGN KEY ("bot_session_id") REFERENCES "public"."bot_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_invocations" ADD CONSTRAINT "bot_invocations_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_invocations" ADD CONSTRAINT "bot_invocations_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_invocations" ADD CONSTRAINT "bot_invocations_trigger_message_id_messages_id_fk" FOREIGN KEY ("trigger_message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_invocations" ADD CONSTRAINT "bot_invocations_response_message_id_messages_id_fk" FOREIGN KEY ("response_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_sessions" ADD CONSTRAINT "bot_sessions_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_sessions" ADD CONSTRAINT "bot_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_sessions" ADD CONSTRAINT "bot_sessions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_sessions" ADD CONSTRAINT "bot_sessions_last_message_id_messages_id_fk" FOREIGN KEY ("last_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bot_events_invocation_id_idx" ON "bot_events" USING btree ("invocation_id");--> statement-breakpoint
CREATE INDEX "bot_events_type_idx" ON "bot_events" USING btree ("type");--> statement-breakpoint
CREATE INDEX "bot_invocations_bot_id_idx" ON "bot_invocations" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "bot_invocations_session_id_idx" ON "bot_invocations" USING btree ("bot_session_id");--> statement-breakpoint
CREATE INDEX "bot_invocations_conversation_id_idx" ON "bot_invocations" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "bot_invocations_trigger_message_id_idx" ON "bot_invocations" USING btree ("trigger_message_id");--> statement-breakpoint
CREATE INDEX "bot_invocations_status_idx" ON "bot_invocations" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_invocations_bot_trigger_idx" ON "bot_invocations" USING btree ("bot_id","trigger_message_id");--> statement-breakpoint
CREATE INDEX "bot_sessions_bot_id_idx" ON "bot_sessions" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "bot_sessions_workspace_id_idx" ON "bot_sessions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "bot_sessions_conversation_id_idx" ON "bot_sessions" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_sessions_bot_conversation_scope_idx" ON "bot_sessions" USING btree ("bot_id","conversation_id","scope");
