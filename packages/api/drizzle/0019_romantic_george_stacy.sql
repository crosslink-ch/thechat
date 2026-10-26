CREATE TABLE "queue_dead_letters" (
	"queue" text NOT NULL,
	"id" uuid NOT NULL,
	"data" jsonb NOT NULL,
	"singleton_key" text,
	"attempts" integer NOT NULL,
	"error" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"dead_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replay_id" uuid,
	"replayed_at" timestamp with time zone,
	CONSTRAINT "queue_dead_letters_queue_id_pk" PRIMARY KEY("queue","id")
);
--> statement-breakpoint
CREATE TABLE "queue_legacy_imports" (
	"source" text NOT NULL,
	"id" text NOT NULL,
	"queue" text NOT NULL,
	"job_id" uuid NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "queue_legacy_imports_source_id_pk" PRIMARY KEY("source","id")
);
