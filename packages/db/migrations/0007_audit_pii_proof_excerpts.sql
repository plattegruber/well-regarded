-- IF NOT EXISTS added by hand: migration 0001 already created the pii
-- schema (drizzle-kit only learned about it now that pii tables exist in
-- the Drizzle schema). Without it this migration fails on every database
-- that has 0001 applied. Generated SQL is reviewed like source code.
CREATE SCHEMA IF NOT EXISTS "pii";
--> statement-breakpoint
CREATE TYPE "public"."audit_actor_type" AS ENUM('staff', 'system', 'patient_token');--> statement-breakpoint
CREATE TYPE "pii"."contact_consent_hint" AS ENUM('unknown', 'implied', 'explicit');--> statement-breakpoint
CREATE TYPE "pii"."contact_kind" AS ENUM('sms', 'email');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pii"."contact_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"kind" "pii"."contact_kind" NOT NULL,
	"value_encrypted" text NOT NULL,
	"value_hash" text NOT NULL,
	"consent_hint" "pii"."contact_consent_hint" DEFAULT 'unknown' NOT NULL,
	"opted_out_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pii"."patients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"external_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proof_excerpts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signal_id" uuid NOT NULL,
	"practice_id" uuid NOT NULL,
	"excerpt_text" text NOT NULL,
	"embedding" vector(1024),
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "excerpt_text")) STORED,
	"topics" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pii"."contact_points" ADD CONSTRAINT "contact_points_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "pii"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pii"."patients" ADD CONSTRAINT "patients_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_excerpts" ADD CONSTRAINT "proof_excerpts_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_excerpts" ADD CONSTRAINT "proof_excerpts_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_practice_id_created_at_idx" ON "audit_log" USING btree ("practice_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_entity_type_entity_id_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "contact_points_value_hash_idx" ON "pii"."contact_points" USING btree ("value_hash");--> statement-breakpoint
CREATE INDEX "contact_points_patient_id_idx" ON "pii"."contact_points" USING btree ("patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_points_patient_id_kind_value_hash_idx" ON "pii"."contact_points" USING btree ("patient_id","kind","value_hash");--> statement-breakpoint
CREATE INDEX "patients_practice_id_idx" ON "pii"."patients" USING btree ("practice_id");--> statement-breakpoint
CREATE INDEX "proof_excerpts_embedding_hnsw_idx" ON "proof_excerpts" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "proof_excerpts_tsv_gin_idx" ON "proof_excerpts" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "proof_excerpts_practice_id_idx" ON "proof_excerpts" USING btree ("practice_id");--> statement-breakpoint
CREATE INDEX "proof_excerpts_signal_id_idx" ON "proof_excerpts" USING btree ("signal_id");--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "pii"."patients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "pii"."patients"("id") ON DELETE set null ON UPDATE no action;