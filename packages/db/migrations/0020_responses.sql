CREATE TYPE "public"."response_status" AS ENUM('draft', 'pending_approval', 'approved', 'published', 'failed');--> statement-breakpoint
CREATE TABLE "responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"signal_id" uuid NOT NULL,
	"author_id" uuid,
	"origin" text DEFAULT 'dashboard' NOT NULL,
	"status" "response_status" DEFAULT 'draft' NOT NULL,
	"body" text NOT NULL,
	"rejection_comment" text,
	"error_detail" jsonb,
	"moderation_state" text,
	"policy_violation" text,
	"published_at" timestamp with time zone,
	"publish_update_time" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_author_id_staff_members_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."staff_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "responses_signal_id_created_at_idx" ON "responses" USING btree ("signal_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "responses_practice_id_status_idx" ON "responses" USING btree ("practice_id","status");