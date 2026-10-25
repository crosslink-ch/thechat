CREATE TABLE "task_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_threads" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "task_projects" ADD CONSTRAINT "task_projects_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_projects" ADD CONSTRAINT "task_projects_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_projects_conversation_idx" ON "task_projects" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_projects_conversation_name_idx" ON "task_projects" USING btree ("conversation_id",lower("name"));--> statement-breakpoint
ALTER TABLE "conversation_threads" ADD CONSTRAINT "conversation_threads_project_id_task_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."task_projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_threads_project_idx" ON "conversation_threads" USING btree ("project_id");