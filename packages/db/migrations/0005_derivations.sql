CREATE TYPE "public"."derivation_basis" AS ENUM('source_metadata', 'manual', 'inferred_text', 'inferred_related');--> statement-breakpoint
CREATE TYPE "public"."derivation_dimension" AS ENUM('sentiment', 'urgency', 'response_risk', 'publication_suitability');--> statement-breakpoint
CREATE TABLE "derivations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signal_id" uuid NOT NULL,
	"practice_id" uuid NOT NULL,
	"dimension" "derivation_dimension" NOT NULL,
	"value" jsonb NOT NULL,
	"confidence" real NOT NULL,
	"basis" "derivation_basis" NOT NULL,
	"model_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "derivations_confidence_range" CHECK ("derivations"."confidence" >= 0 AND "derivations"."confidence" <= 1)
);
--> statement-breakpoint
ALTER TABLE "derivations" ADD CONSTRAINT "derivations_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "derivations" ADD CONSTRAINT "derivations_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "derivations_signal_id_dimension_created_at_idx" ON "derivations" USING btree ("signal_id","dimension","created_at" DESC NULLS LAST);