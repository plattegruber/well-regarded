CREATE TYPE "public"."staff_role" AS ENUM('owner', 'office_manager', 'front_desk', 'marketing', 'provider', 'multi_location_admin', 'external_partner');--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"practice_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"google_place_id" text,
	"phone" text
);
--> statement-breakpoint
CREATE TABLE "practices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"clerk_org_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"timezone" text DEFAULT 'America/Chicago' NOT NULL,
	"website_url" text,
	"phone" text,
	CONSTRAINT "practices_clerk_org_id_unique" UNIQUE("clerk_org_id"),
	CONSTRAINT "practices_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"practice_id" uuid NOT NULL,
	"location_id" uuid,
	"display_name" text NOT NULL,
	"full_name" text,
	"credentials" text,
	"bio" text,
	"photo_key" text,
	"active" boolean DEFAULT true NOT NULL,
	"staff_member_id" uuid
);
--> statement-breakpoint
CREATE TABLE "staff_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"practice_id" uuid NOT NULL,
	"clerk_user_id" text NOT NULL,
	"role" "staff_role" DEFAULT 'front_desk' NOT NULL,
	"location_id" uuid,
	"email" text NOT NULL,
	"display_name" text,
	"deactivated_at" timestamp with time zone,
	CONSTRAINT "staff_members_practice_id_clerk_user_id_unique" UNIQUE("practice_id","clerk_user_id")
);
--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "providers" ADD CONSTRAINT "providers_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "providers" ADD CONSTRAINT "providers_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "providers" ADD CONSTRAINT "providers_staff_member_id_staff_members_id_fk" FOREIGN KEY ("staff_member_id") REFERENCES "public"."staff_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_members" ADD CONSTRAINT "staff_members_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "locations_practice_id_idx" ON "locations" USING btree ("practice_id");--> statement-breakpoint
CREATE INDEX "providers_practice_id_idx" ON "providers" USING btree ("practice_id");--> statement-breakpoint
CREATE INDEX "staff_members_clerk_user_id_idx" ON "staff_members" USING btree ("clerk_user_id");--> statement-breakpoint
CREATE INDEX "staff_members_practice_id_idx" ON "staff_members" USING btree ("practice_id");