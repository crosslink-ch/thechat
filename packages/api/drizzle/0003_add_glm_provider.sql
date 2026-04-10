ALTER TYPE "public"."workspace_provider" ADD VALUE 'glm';--> statement-breakpoint
ALTER TABLE "workspace_configs" ADD COLUMN "glm_api_key" text;--> statement-breakpoint
ALTER TABLE "workspace_configs" ADD COLUMN "glm_model" text;