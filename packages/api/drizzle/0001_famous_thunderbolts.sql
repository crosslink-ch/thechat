CREATE TYPE "public"."workspace_provider" AS ENUM('openrouter', 'codex');--> statement-breakpoint
CREATE TABLE "workspace_configs" (
	"workspace_id" varchar(100) PRIMARY KEY NOT NULL,
	"provider" "workspace_provider",
	"openrouter_api_key" text,
	"openrouter_model" text,
	"codex_model" text,
	"reasoning_effort" varchar(20),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_configs" ADD CONSTRAINT "workspace_configs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;