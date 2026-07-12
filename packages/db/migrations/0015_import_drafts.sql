CREATE TYPE "public"."import_draft_status" AS ENUM('draft', 'confirmed', 'superseded');--> statement-breakpoint
CREATE TABLE "import_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"r2_key" text NOT NULL,
	"original_filename" text NOT NULL,
	"byte_size" integer NOT NULL,
	"headers" jsonb NOT NULL,
	"mapping" jsonb,
	"status" "import_draft_status" DEFAULT 'draft' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_drafts" ADD CONSTRAINT "import_drafts_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_drafts" ADD CONSTRAINT "import_drafts_created_by_staff_members_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_drafts_practice_id_created_at_idx" ON "import_drafts" USING btree ("practice_id","created_at" DESC NULLS LAST);