-- Hand-written migration (drizzle-kit generate --custom).
--
-- Foundations every later migration in Epic #3 relies on:
--   * pgvector for embedding columns / HNSW indexes
--   * the isolated `pii` schema (HIPAA-shaped boundary for encrypted contact fields)
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS pii;

-- THROWAWAY edit for #55 negative test (b); reverted
