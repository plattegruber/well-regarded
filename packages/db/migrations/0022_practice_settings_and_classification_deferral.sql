CREATE TABLE "practice_settings" (
	"practice_id" uuid PRIMARY KEY NOT NULL,
	"ai" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "classification_deferred_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "practice_settings" ADD CONSTRAINT "practice_settings_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;