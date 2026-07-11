-- Hand-written migration (drizzle-kit generate --custom), issue #35.
--
-- Immutability of original signal content, enforced at the database rather
-- than by convention: the patient's words as captured are never rewritten.
-- Classification, editing, and consent all happen in other tables
-- (derivations, consents) that reference signals.
--
-- One carve-out: the compliance lifecycle (Epic #23) transitions
-- retention_state to 'redacted'/'purged' and nulls the original content in
-- the same UPDATE. That is the only path allowed to change these columns —
-- and only to NULL.
--
-- Named signals_protect_original() so the audit-log issue's trigger naming
-- stays consistent.
CREATE FUNCTION signals_protect_original() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.original_text IS DISTINCT FROM OLD.original_text
     OR NEW.original_rating IS DISTINCT FROM OLD.original_rating THEN
    -- Carve-out: redaction/purge may null the content, nothing else.
    IF NEW.retention_state IN ('redacted', 'purged')
       AND NEW.original_text IS NULL
       AND NEW.original_rating IS NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'signals.original_text and signals.original_rating are immutable (signal %). The only permitted change is nulling both while setting retention_state to redacted/purged.', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER signals_protect_original
BEFORE UPDATE ON signals
FOR EACH ROW
EXECUTE FUNCTION signals_protect_original();
