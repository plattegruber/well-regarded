ALTER TABLE "proof_excerpts" ADD COLUMN "start_offset" integer;--> statement-breakpoint
ALTER TABLE "proof_excerpts" ADD COLUMN "topic_hint" text;--> statement-breakpoint
ALTER TABLE "proof_excerpts" ADD COLUMN "embedding_model" text DEFAULT '@cf/baai/bge-m3' NOT NULL;