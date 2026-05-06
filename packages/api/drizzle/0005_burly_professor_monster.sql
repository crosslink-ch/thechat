CREATE TYPE "public"."bot_kind" AS ENUM('webhook', 'hermes');--> statement-breakpoint
CREATE TABLE "hermes_bot_configs" (
	"bot_id" uuid PRIMARY KEY NOT NULL,
	"base_url" text NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"default_mode" varchar(20) DEFAULT 'run' NOT NULL,
	"default_instructions" text,
	"default_session_scope" varchar(20) DEFAULT 'channel' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "kind" "bot_kind" DEFAULT 'webhook' NOT NULL;--> statement-breakpoint
ALTER TABLE "hermes_bot_configs" ADD CONSTRAINT "hermes_bot_configs_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;