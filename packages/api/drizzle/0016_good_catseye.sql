CREATE TABLE "hermes_rpc_allowed_users" (
	"bot_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "hermes_rpc_allowed_users_bot_id_user_id_pk" PRIMARY KEY("bot_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "hermes_rpc_bot_configs" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "hermes_rpc_allowed_users" ADD CONSTRAINT "hermes_rpc_allowed_users_bot_id_hermes_rpc_bot_configs_bot_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."hermes_rpc_bot_configs"("bot_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hermes_rpc_allowed_users" ADD CONSTRAINT "hermes_rpc_allowed_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;