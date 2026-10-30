ALTER TABLE "messages" ADD COLUMN "quote_text" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "quote_message_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_quote_message_id_fk" FOREIGN KEY ("quote_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_quote_message_id_idx" ON "messages" USING btree ("quote_message_id") WHERE "messages"."quote_message_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_quote_source_has_text" CHECK ("messages"."quote_message_id" IS NULL OR "messages"."quote_text" IS NOT NULL);