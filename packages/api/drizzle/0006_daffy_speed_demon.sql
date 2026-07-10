CREATE TABLE "event_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_type" varchar(255) NOT NULL,
	"event_version" integer NOT NULL,
	"aggregate_type" varchar(100) NOT NULL,
	"aggregate_id" varchar(255) NOT NULL,
	"actor_type" varchar(100),
	"actor_id" varchar(255),
	"tenant_id" varchar(100),
	"correlation_id" varchar(255),
	"causation_id" varchar(255),
	"partition_key" varchar(255) NOT NULL,
	"event" jsonb NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"dead_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"locked_by" varchar(255),
	"locked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "event_outbox_pending_idx" ON "event_outbox" USING btree ("published_at","dead_at","available_at","created_at");--> statement-breakpoint
CREATE INDEX "event_outbox_lock_idx" ON "event_outbox" USING btree ("published_at","dead_at","locked_at");--> statement-breakpoint
CREATE INDEX "event_outbox_partition_order_idx" ON "event_outbox" USING btree ("partition_key","published_at","dead_at","created_at","id");--> statement-breakpoint
CREATE INDEX "event_outbox_aggregate_idx" ON "event_outbox" USING btree ("aggregate_type","aggregate_id");--> statement-breakpoint
CREATE INDEX "event_outbox_correlation_idx" ON "event_outbox" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "event_outbox_published_retention_idx" ON "event_outbox" USING btree ("published_at");