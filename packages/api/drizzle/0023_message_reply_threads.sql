CREATE TABLE "message_thread_followers" (
	"root_message_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"following" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_thread_followers_root_message_id_user_id_pk" PRIMARY KEY("root_message_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "parent_message_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "also_sent_to_conversation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "reply_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "last_reply_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "thread_replies" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "message_thread_followers" ADD CONSTRAINT "message_thread_followers_root_message_id_messages_id_fk" FOREIGN KEY ("root_message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_thread_followers" ADD CONSTRAINT "message_thread_followers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_thread_followers" ADD CONSTRAINT "message_thread_followers_participant_fk" FOREIGN KEY ("conversation_id","user_id") REFERENCES "public"."conversation_participants"("conversation_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_thread_followers_user_idx" ON "message_thread_followers" USING btree ("user_id","following");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_parent_message_id_fk" FOREIGN KEY ("parent_message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_parent_created_idx" ON "messages" USING btree ("parent_message_id","created_at","id");