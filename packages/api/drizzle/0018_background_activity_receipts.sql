CREATE TABLE "bot_activity_receipts" (
	"bot_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"sequence" varchar(20) NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	CONSTRAINT "bot_activity_receipts_bot_id_event_id_pk" PRIMARY KEY("bot_id","event_id")
);
--> statement-breakpoint
ALTER TABLE "bot_activity_receipts" ADD CONSTRAINT "bot_activity_receipts_bot_id_task_id_bot_activity_snapshots_bot_id_task_id_fk" FOREIGN KEY ("bot_id","task_id") REFERENCES "public"."bot_activity_snapshots"("bot_id","task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bot_activity_receipt_sequence_idx" ON "bot_activity_receipts" USING btree ("bot_id","task_id","sequence");