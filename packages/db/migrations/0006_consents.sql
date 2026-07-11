CREATE TYPE "public"."consent_attribution" AS ENUM('full_name', 'first_name', 'initials', 'anonymous');--> statement-breakpoint
CREATE TYPE "public"."consent_channel" AS ENUM('website', 'gbp', 'email', 'in_office');--> statement-breakpoint
CREATE TYPE "public"."consent_source" AS ENUM('patient_link', 'practice_attested', 'imported_unknown');--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"signal_id" uuid NOT NULL,
	"patient_id" uuid,
	"channels" "consent_channel"[] NOT NULL,
	"attribution" "consent_attribution" NOT NULL,
	"allow_minor_edits" boolean DEFAULT false NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"source" "consent_source" NOT NULL,
	"consent_version" integer NOT NULL,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "consents_signal_id_consent_version_idx" ON "consents" USING btree ("signal_id","consent_version");--> statement-breakpoint
CREATE INDEX "consents_signal_id_granted_at_idx" ON "consents" USING btree ("signal_id","granted_at" DESC NULLS LAST);