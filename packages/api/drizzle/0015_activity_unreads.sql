CREATE TABLE "message_unreads" (
	"message_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_unreads_message_id_user_id_pk" PRIMARY KEY("message_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "message_unreads" ADD CONSTRAINT "message_unreads_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_unreads" ADD CONSTRAINT "message_unreads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_unreads" ADD CONSTRAINT "message_unreads_participant_fk" FOREIGN KEY ("conversation_id","user_id") REFERENCES "public"."conversation_participants"("conversation_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_unreads_user_conversation_idx" ON "message_unreads" USING btree ("user_id","conversation_id");--> statement-breakpoint
CREATE INDEX "message_unreads_user_created_at_idx" ON "message_unreads" USING btree ("user_id","created_at");