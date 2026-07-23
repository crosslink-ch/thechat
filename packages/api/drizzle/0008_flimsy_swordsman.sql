CREATE TYPE "public"."attachment_status" AS ENUM('pending_upload', 'processing', 'ready', 'attached', 'rejected', 'deleting', 'deleted');--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"uploader_id" uuid NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"declared_media_type" varchar(255) NOT NULL,
	"declared_size_bytes" integer NOT NULL,
	"declared_checksum_sha256" varchar(64) NOT NULL,
	"verified_media_type" varchar(255),
	"verified_size_bytes" integer,
	"verified_checksum_sha256" varchar(64),
	"width" integer,
	"height" integer,
	"status" "attachment_status" DEFAULT 'pending_upload' NOT NULL,
	"quarantine_key" text NOT NULL,
	"quarantine_version_id" text,
	"clean_key" text,
	"clean_version_id" text,
	"failure_reason" varchar(255),
	"upload_expires_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"processing_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"attached_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"deleting_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_attachments" (
	"message_id" uuid NOT NULL,
	"attachment_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "message_attachments_message_id_position_pk" PRIMARY KEY("message_id","position")
);
--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "attachment_access" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "client_message_id" varchar(255);--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_conversation_idx" ON "attachments" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "attachments_uploader_idx" ON "attachments" USING btree ("uploader_id");--> statement-breakpoint
CREATE INDEX "attachments_status_expiry_idx" ON "attachments" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "message_attachments_attachment_idx" ON "message_attachments" USING btree ("attachment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_attachments_message_attachment_idx" ON "message_attachments" USING btree ("message_id","attachment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_sender_client_message_idx" ON "messages" USING btree ("sender_id","client_message_id");