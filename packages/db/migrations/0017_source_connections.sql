CREATE TYPE "public"."source_connection_kind" AS ENUM('google');--> statement-breakpoint
CREATE TYPE "public"."source_connection_status" AS ENUM('active', 'needs_reauth', 'disconnected');--> statement-breakpoint
CREATE TABLE "source_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"kind" "source_connection_kind" NOT NULL,
	"status" "source_connection_status" DEFAULT 'active' NOT NULL,
	"encrypted_credentials" text,
	"scopes" text[] NOT NULL,
	"connected_by" uuid,
	"last_sync_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_connections_practice_id_kind_unique" UNIQUE("practice_id","kind")
);
--> statement-breakpoint
ALTER TABLE "source_connections" ADD CONSTRAINT "source_connections_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_connections" ADD CONSTRAINT "source_connections_connected_by_staff_members_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."staff_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_connections_practice_id_idx" ON "source_connections" USING btree ("practice_id");