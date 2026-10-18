CREATE TABLE "bot_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"thread_id" uuid,
	"invocation_id" uuid,
	"client_key" varchar(255) NOT NULL,
	"kind" varchar(20) NOT NULL,
	"title" varchar(300) NOT NULL,
	"body" text,
	"details" jsonb,
	"response_spec" jsonb NOT NULL,
	"order_group" varchar(255),
	"audience_user_id" uuid,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"answer" jsonb,
	"answered_by" uuid,
	"answered_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"delivery_applied" boolean,
	"delivery_note" varchar(500),
	"cancel_reason" varchar(500),
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot_requests" ADD CONSTRAINT "bot_requests_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_requests" ADD CONSTRAINT "bot_requests_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_requests" ADD CONSTRAINT "bot_requests_thread_id_conversation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."conversation_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_requests" ADD CONSTRAINT "bot_requests_invocation_id_bot_invocations_id_fk" FOREIGN KEY ("invocation_id") REFERENCES "public"."bot_invocations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_requests" ADD CONSTRAINT "bot_requests_audience_user_id_users_id_fk" FOREIGN KEY ("audience_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_requests" ADD CONSTRAINT "bot_requests_answered_by_users_id_fk" FOREIGN KEY ("answered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bot_requests_bot_client_key_idx" ON "bot_requests" USING btree ("bot_id","client_key");--> statement-breakpoint
CREATE INDEX "bot_requests_conversation_status_idx" ON "bot_requests" USING btree ("conversation_id","status");--> statement-breakpoint
CREATE INDEX "bot_requests_bot_status_idx" ON "bot_requests" USING btree ("bot_id","status");--> statement-breakpoint
CREATE INDEX "bot_requests_audience_status_idx" ON "bot_requests" USING btree ("audience_user_id","status");--> statement-breakpoint
CREATE INDEX "bot_requests_invocation_idx" ON "bot_requests" USING btree ("invocation_id");--> statement-breakpoint
CREATE INDEX "bot_requests_open_expiry_idx" ON "bot_requests" USING btree ("expires_at") WHERE "bot_requests"."status" = 'open' AND "bot_requests"."expires_at" IS NOT NULL;