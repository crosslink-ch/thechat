ALTER TYPE "public"."workspace_provider" ADD VALUE 'featherless';--> statement-breakpoint
ALTER TABLE "workspace_configs" ADD COLUMN "featherless_api_key" text;--> statement-breakpoint
ALTER TABLE "workspace_configs" ADD COLUMN "featherless_model" text;