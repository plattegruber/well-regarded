CREATE TYPE "public"."import_run_status" AS ENUM('running', 'completed', 'completed_with_errors', 'failed');--> statement-breakpoint
CREATE TYPE "public"."import_run_trigger" AS ENUM('manual', 'cron', 'webhook');--> statement-breakpoint
CREATE TYPE "public"."signal_pipeline_status" AS ENUM('pending_dedupe', 'pending_classify', 'pending_route', 'processed');--> statement-breakpoint
CREATE TABLE "import_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"source_kind" "source_kind" NOT NULL,
	"trigger" "import_run_trigger" NOT NULL,
	"status" "import_run_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created" integer DEFAULT 0 NOT NULL,
	"merged" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_samples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw_artifact_keys" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "provider_hint" jsonb;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "location_hint" jsonb;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "pipeline_status" "signal_pipeline_status" DEFAULT 'pending_dedupe' NOT NULL;--> statement-breakpoint
-- Hand-written backfill (compatible with the drift gate, which only compares
-- schema to snapshot): every signal that exists before this migration
-- predates the pipeline spine and is already display-ready, so it lands at
-- the terminal state rather than the insert-time default.
UPDATE "signals" SET "pipeline_status" = 'processed';--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_runs_practice_id_started_at_idx" ON "import_runs" USING btree ("practice_id","started_at" DESC NULLS LAST);--> statement-breakpoint
-- Hand-written backfill: `signals.import_run_id` predates this table (the
-- Epic #1 seed stamps a deterministic run id on its csv_import signals; see
-- packages/db/src/seed/constants.ts, which promised "Epic #6 backfills the
-- run row"). Materialize a completed run row for any orphaned id so the FK
-- below validates on already-seeded databases. Fresh databases: no-op.
INSERT INTO "import_runs" ("id", "practice_id", "source_kind", "trigger", "status", "started_at", "finished_at", "created")
SELECT DISTINCT ON (s."import_run_id")
	s."import_run_id", s."practice_id", s."source_kind", 'manual', 'completed', now(), now(), 0
FROM "signals" s
LEFT JOIN "import_runs" ir ON ir."id" = s."import_run_id"
WHERE s."import_run_id" IS NOT NULL AND ir."id" IS NULL;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_import_run_id_import_runs_id_fk" FOREIGN KEY ("import_run_id") REFERENCES "public"."import_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signals_import_run_id_idx" ON "signals" USING btree ("import_run_id") WHERE "signals"."import_run_id" IS NOT NULL;