ALTER TYPE "public"."bot_kind" ADD VALUE 'hermes-rpc';--> statement-breakpoint
CREATE TABLE "hermes_rpc_bot_configs" (
	"bot_id" uuid PRIMARY KEY NOT NULL,
	"endpoint" text NOT NULL,
	"gateway_token_encrypted" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hermes_rpc_session_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"thread_id" uuid,
	"upstream_session_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hermes_rpc_bot_configs" ADD CONSTRAINT "hermes_rpc_bot_configs_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_rpc_session_links" ADD CONSTRAINT "hermes_rpc_session_links_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_rpc_session_links" ADD CONSTRAINT "hermes_rpc_session_links_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_rpc_session_links" ADD CONSTRAINT "hermes_rpc_session_links_thread_id_conversation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."conversation_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hermes_rpc_session_links_upstream_idx" ON "hermes_rpc_session_links" USING btree ("bot_id","upstream_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hermes_rpc_session_links_thread_idx" ON "hermes_rpc_session_links" USING btree ("bot_id","conversation_id","thread_id") WHERE "hermes_rpc_session_links"."thread_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "hermes_rpc_session_links_general_idx" ON "hermes_rpc_session_links" USING btree ("bot_id","conversation_id") WHERE "hermes_rpc_session_links"."thread_id" is null;
