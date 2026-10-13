ALTER TABLE "bots" ADD COLUMN "endpoint_revision" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE TABLE "bot_installation_channels" (
	"workspace_id" varchar(100) NOT NULL,
	"bot_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	CONSTRAINT "bot_installation_channels_workspace_id_bot_id_conversation_id_pk" PRIMARY KEY("workspace_id","bot_id","conversation_id")
);
--> statement-breakpoint
CREATE TABLE "bot_workspace_installations" (
	"workspace_id" varchar(100) NOT NULL,
	"bot_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"channel_scope" varchar(20) DEFAULT 'selected' NOT NULL,
	"attachment_access" boolean DEFAULT false NOT NULL,
	"shared_runtime_consent" boolean DEFAULT false NOT NULL,
	"approved_endpoint_url" text,
	"approved_endpoint_revision" integer DEFAULT 1 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"approved_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_workspace_installations_workspace_id_bot_id_pk" PRIMARY KEY("workspace_id","bot_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_workspace_id_id_idx" ON "conversations" USING btree ("workspace_id","id");
--> statement-breakpoint
ALTER TABLE "bot_installation_channels" ADD CONSTRAINT "bot_installation_channels_workspace_id_bot_id_bot_workspace_installations_workspace_id_bot_id_fk" FOREIGN KEY ("workspace_id","bot_id") REFERENCES "public"."bot_workspace_installations"("workspace_id","bot_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_installation_channels" ADD CONSTRAINT "bot_installation_channels_workspace_id_conversation_id_conversations_workspace_id_id_fk" FOREIGN KEY ("workspace_id","conversation_id") REFERENCES "public"."conversations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_workspace_installations" ADD CONSTRAINT "bot_workspace_installations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_workspace_installations" ADD CONSTRAINT "bot_workspace_installations_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_workspace_installations" ADD CONSTRAINT "bot_workspace_installations_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Explicit compatibility backfill: prior administrator-approved memberships retain
-- workspace-wide scope, existing global attachment ceiling and the current endpoint.
-- This is a one-time migration, never a permission-on-absence runtime fallback.
INSERT INTO bot_workspace_installations (workspace_id,bot_id,enabled,channel_scope,attachment_access,shared_runtime_consent,approved_endpoint_url,approved_endpoint_revision,revision)
SELECT wm.workspace_id,b.id,true,'all',b.attachment_access,true,b.webhook_url,1,1
FROM workspace_members wm JOIN bots b ON b.user_id=wm.user_id;
