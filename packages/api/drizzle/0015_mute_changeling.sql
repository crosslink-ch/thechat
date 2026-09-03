ALTER TYPE "public"."bot_kind" ADD VALUE 'hermes-rpc';--> statement-breakpoint
CREATE TABLE "hermes_rpc_bot_configs" (
	"bot_id" uuid PRIMARY KEY NOT NULL,
	"endpoint" text NOT NULL,
	"gateway_token_encrypted" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hermes_rpc_bot_configs" ADD CONSTRAINT "hermes_rpc_bot_configs_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;