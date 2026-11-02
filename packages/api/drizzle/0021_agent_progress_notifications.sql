ALTER TABLE "messages" ADD COLUMN "interim" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "agent_progress" boolean DEFAULT false NOT NULL;