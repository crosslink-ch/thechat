CREATE TABLE "bot_invocation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invocation_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"status" varchar(32),
	"tool_call_id" text,
	"tool_name" text,
	"label" text,
	"preview" text,
	"payload_json" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot_invocation_events" ADD CONSTRAINT "bot_invocation_events_invocation_id_bot_invocations_id_fk" FOREIGN KEY ("invocation_id") REFERENCES "public"."bot_invocations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_invocation_events" ADD CONSTRAINT "bot_invocation_events_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_invocation_events" ADD CONSTRAINT "bot_invocation_events_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bot_invocation_events_invocation_id_idx" ON "bot_invocation_events" USING btree ("invocation_id");--> statement-breakpoint
CREATE INDEX "bot_invocation_events_conversation_id_idx" ON "bot_invocation_events" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "bot_invocation_events_bot_id_idx" ON "bot_invocation_events" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "bot_invocation_events_created_at_idx" ON "bot_invocation_events" USING btree ("created_at");