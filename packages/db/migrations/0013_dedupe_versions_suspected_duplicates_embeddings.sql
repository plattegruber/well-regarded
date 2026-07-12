CREATE TYPE "public"."suspected_duplicate_status" AS ENUM('pending_review', 'confirmed', 'dismissed');--> statement-breakpoint
CREATE TABLE "signal_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signal_id" uuid NOT NULL,
	"content" text,
	"rating" numeric(2, 1),
	"source_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suspected_duplicates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"signal_id_a" uuid NOT NULL,
	"signal_id_b" uuid NOT NULL,
	"similarity" double precision NOT NULL,
	"status" "suspected_duplicate_status" DEFAULT 'pending_review' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suspected_duplicates_pair_ordered" CHECK ("suspected_duplicates"."signal_id_a" < "suspected_duplicates"."signal_id_b")
);
--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "current_version_id" uuid;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "embedding" vector(1024);--> statement-breakpoint
ALTER TABLE "signal_versions" ADD CONSTRAINT "signal_versions_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suspected_duplicates" ADD CONSTRAINT "suspected_duplicates_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suspected_duplicates" ADD CONSTRAINT "suspected_duplicates_signal_id_a_signals_id_fk" FOREIGN KEY ("signal_id_a") REFERENCES "public"."signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suspected_duplicates" ADD CONSTRAINT "suspected_duplicates_signal_id_b_signals_id_fk" FOREIGN KEY ("signal_id_b") REFERENCES "public"."signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signal_versions_signal_id_created_at_idx" ON "signal_versions" USING btree ("signal_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "suspected_duplicates_pair_idx" ON "suspected_duplicates" USING btree ("signal_id_a","signal_id_b");--> statement-breakpoint
CREATE INDEX "suspected_duplicates_practice_id_status_idx" ON "suspected_duplicates" USING btree ("practice_id","status");--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_current_version_id_signal_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."signal_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signals_embedding_hnsw_idx" ON "signals" USING hnsw ("embedding" vector_cosine_ops);