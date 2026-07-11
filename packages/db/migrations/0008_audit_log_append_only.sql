-- Hand-written migration (drizzle-kit generate --custom), issue #46.
--
-- audit_log is append-only, enforced by the database rather than by code
-- review: rows can never be altered or removed. The trigger is deliberately
-- dumb — no conditions, no carve-outs. If a future retention requirement
-- ever needs to purge audit rows, that is a deliberate migration under
-- Epic #23, not a code path.
--
-- TRUNCATE cannot be blocked by a FOR EACH ROW trigger, so it is revoked
-- instead: REVOKE from PUBLIC here, and it is never granted to the app
-- role. (Table owners/superusers can still TRUNCATE — Postgres has no way
-- to revoke that from the owner — which is exactly the "deliberate
-- migration, not a code path" escape hatch above.)
CREATE FUNCTION audit_log_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_block_mutation
BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW
EXECUTE FUNCTION audit_log_block_mutation();
--> statement-breakpoint
REVOKE TRUNCATE ON audit_log FROM PUBLIC;
