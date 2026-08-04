CREATE TYPE "public"."bot_workspace_invite_status" AS ENUM('pending', 'accepted', 'declined', 'cancelled');--> statement-breakpoint
CREATE TABLE "bot_workspace_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" varchar(100) NOT NULL,
	"bot_id" uuid NOT NULL,
	"requester_id" uuid NOT NULL,
	"status" "bot_workspace_invite_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot_workspace_invites" ADD CONSTRAINT "bot_workspace_invites_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_workspace_invites" ADD CONSTRAINT "bot_workspace_invites_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_workspace_invites" ADD CONSTRAINT "bot_workspace_invites_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bwi_workspace_id_idx" ON "bot_workspace_invites" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "bwi_bot_id_idx" ON "bot_workspace_invites" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "bwi_requester_id_idx" ON "bot_workspace_invites" USING btree ("requester_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bwi_workspace_bot_pending_idx" ON "bot_workspace_invites" USING btree ("workspace_id","bot_id") WHERE "bot_workspace_invites"."status" = 'pending';