CREATE TYPE "public"."placement_channel" AS ENUM('website', 'gbp_post', 'email', 'in_office');--> statement-breakpoint
CREATE TYPE "public"."proof_status" AS ENUM('suggested', 'approved', 'archived');--> statement-breakpoint
CREATE TABLE "placements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"proof_id" uuid NOT NULL,
	"channel" "placement_channel" NOT NULL,
	"target" text,
	"active" boolean DEFAULT true NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deactivated_at" timestamp with time zone,
	"deactivation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proofs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"signal_id" uuid NOT NULL,
	"excerpt_id" uuid,
	"display_text" text,
	"status" "proof_status" DEFAULT 'suggested' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "placements" ADD CONSTRAINT "placements_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placements" ADD CONSTRAINT "placements_proof_id_proofs_id_fk" FOREIGN KEY ("proof_id") REFERENCES "public"."proofs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proofs" ADD CONSTRAINT "proofs_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proofs" ADD CONSTRAINT "proofs_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proofs" ADD CONSTRAINT "proofs_approved_by_staff_members_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."staff_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The "excerpt belongs to the same signal" invariant (issue #96) is the
-- composite FK below — the simplest shape Drizzle supports. It needs this
-- unique index over the referenced columns FIRST (moved up from the end of
-- the generated file: drizzle-kit emits indexes after FKs, which would fail
-- here). MATCH SIMPLE makes the FK vacuous when excerpt_id IS NULL — the
-- whole-signal case.
CREATE UNIQUE INDEX "proof_excerpts_signal_id_id_uniq" ON "proof_excerpts" USING btree ("signal_id","id");--> statement-breakpoint
ALTER TABLE "proofs" ADD CONSTRAINT "proofs_signal_id_excerpt_id_fk" FOREIGN KEY ("signal_id","excerpt_id") REFERENCES "public"."proof_excerpts"("signal_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "placements_proof_id_idx" ON "placements" USING btree ("proof_id");--> statement-breakpoint
CREATE INDEX "placements_practice_id_active_idx" ON "placements" USING btree ("practice_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "proofs_signal_whole_live_uniq" ON "proofs" USING btree ("signal_id") WHERE "excerpt_id" IS NULL AND "status" <> 'archived';--> statement-breakpoint
CREATE UNIQUE INDEX "proofs_signal_excerpt_live_uniq" ON "proofs" USING btree ("signal_id","excerpt_id") WHERE "excerpt_id" IS NOT NULL AND "status" <> 'archived';--> statement-breakpoint
CREATE INDEX "proofs_practice_id_status_idx" ON "proofs" USING btree ("practice_id","status");--> statement-breakpoint
CREATE INDEX "proofs_signal_id_idx" ON "proofs" USING btree ("signal_id");