ALTER TYPE "public"."workspace_provider" ADD VALUE 'azulai';--> statement-breakpoint
ALTER TABLE "workspace_configs" ADD COLUMN "azulai_api_url" text;--> statement-breakpoint
ALTER TABLE "workspace_configs" ADD COLUMN "azulai_api_key" text;--> statement-breakpoint
ALTER TABLE "workspace_configs" ADD COLUMN "azulai_model" text;