CREATE TYPE "public"."retention_state" AS ENUM('active', 'redacted', 'purged');--> statement-breakpoint
CREATE TYPE "public"."signal_availability" AS ENUM('available', 'deleted_at_source');--> statement-breakpoint
CREATE TYPE "public"."signal_visibility" AS ENUM('public', 'private');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('google', 'csv_import', 'manual', 'email', 'firstparty', 'opendental');--> statement-breakpoint
CREATE TABLE "signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"patient_id" uuid,
	"location_id" uuid,
	"provider_id" uuid,
	"source_kind" "source_kind" NOT NULL,
	"source_id" text,
	"source_url" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"raw_artifact_key" text,
	"import_run_id" uuid,
	"original_text" text,
	"original_rating" numeric(2, 1),
	"visibility" "signal_visibility" NOT NULL,
	"availability" "signal_availability" DEFAULT 'available' NOT NULL,
	"retention_state" "retention_state" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "signals_practice_id_source_kind_source_id_idx" ON "signals" USING btree ("practice_id","source_kind","source_id") WHERE "signals"."source_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "signals_practice_id_occurred_at_idx" ON "signals" USING btree ("practice_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "signals_practice_id_visibility_occurred_at_idx" ON "signals" USING btree ("practice_id","visibility","occurred_at" DESC NULLS LAST);