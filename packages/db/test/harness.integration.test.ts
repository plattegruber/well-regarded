/**
 * Meta-tests for the test harness itself (issue #49, Epic #3): per-scope
 * database isolation, template fidelity (extensions, schemas, triggers all
 * survive `CREATE DATABASE ... TEMPLATE`), and factories that satisfy
 * every NOT NULL / unique / FK constraint for the covered tables.
 */

import { sql as dsql, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { auditLog } from "../src/schema/audit.js";
import { signals } from "../src/schema/signals.js";
import { practices } from "../src/schema/tenancy.js";
import {
  consent,
  contactPoint,
  derivation,
  location,
  patient,
  practice,
  proofExcerpt,
  provider,
  signal,
  staffMember,
  TEST_KEYRING,
} from "./factories.js";
import { pgError, setupTestDb } from "./harness.js";
import { TEMPLATE_DB } from "./support.js";

const ISOLATION_MARKER = "org_isolation_marker";
const seenDatabaseNames: string[] = [];

/** RAISE EXCEPTION in a plpgsql trigger without an explicit ERRCODE. */
const RAISE_EXCEPTION = "P0001";

describe("scope A: writes a marker row into its own database", () => {
  const t = setupTestDb();

  it("runs in a private test_ database, not the shared one", () => {
    seenDatabaseNames.push(t.databaseName);
    // test_<created-epoch>_<pid>_<n> — the epoch is what the orphan sweep
    // reads to spare live concurrent runs' databases (globalSetup.ts).
    expect(t.databaseName).toMatch(/^test_\d{10,}_\d+_\d+$/);
  });

  it("clones from a template stamped with the migrations fingerprint", async () => {
    const [row] = await t.sql`
      SELECT shobj_description(oid, 'pg_database') AS fingerprint
      FROM pg_database WHERE datname = ${TEMPLATE_DB}
    `;
    expect(row?.fingerprint).toMatch(/^migrations sha256:[0-9a-f]{64}$/);
  });

  it("inserts the marker row other scopes must never see", async () => {
    await practice(t.db, { clerkOrgId: ISOLATION_MARKER });
    const rows = await t.db
      .select()
      .from(practices)
      .where(eq(practices.clerkOrgId, ISOLATION_MARKER));
    expect(rows).toHaveLength(1);
  });
});

describe("scope B: gets a different, empty database", () => {
  const t = setupTestDb();

  it("has a different database name than scope A", () => {
    seenDatabaseNames.push(t.databaseName);
    expect(seenDatabaseNames).toHaveLength(2);
    expect(seenDatabaseNames[0]).not.toBe(seenDatabaseNames[1]);
  });

  it("cannot see scope A's rows", async () => {
    const rows = await t.db
      .select()
      .from(practices)
      .where(eq(practices.clerkOrgId, ISOLATION_MARKER));
    expect(rows).toHaveLength(0);
    // Not just the marker — the clone starts with zero practices.
    const all = await t.db.select().from(practices);
    expect(all).toHaveLength(0);
  });
});

describe("template fidelity: the clone is the real schema", () => {
  const t = setupTestDb();

  it("has the vector extension and the pii schema", async () => {
    const ext = await t.sql`
      SELECT extname FROM pg_extension WHERE extname = 'vector'
    `;
    expect(ext).toHaveLength(1);
    const schema = await t.sql`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name = 'pii'
    `;
    expect(schema).toHaveLength(1);
  });

  it("carries the hand-written triggers (signals_protect_original)", async () => {
    const row = await signal(t.db, { originalText: "as captured" });
    const { code, message } = await pgError(
      t.db
        .update(signals)
        .set({ originalText: "edited" })
        .where(eq(signals.id, row.id)),
    );
    expect(code).toBe(RAISE_EXCEPTION);
    expect(message).toContain("immutable");
  });

  it("carries the audit_log append-only trigger", async () => {
    const p = await practice(t.db);
    const [entry] = await t.db
      .insert(auditLog)
      .values({
        practiceId: p.id,
        actorType: "system",
        actorId: "test:harness",
        action: "consent.granted",
        entityType: "consents",
        entityId: "meta-test",
      })
      .returning();
    if (!entry) throw new Error("audit insert returned no row");
    const { code } = await pgError(
      t.db.delete(auditLog).where(eq(auditLog.id, entry.id)),
    );
    expect(code).toBe(RAISE_EXCEPTION);
  });
});

describe("factories: one of everything, constraints satisfied", () => {
  const t = setupTestDb();

  it("builds every tenancy row with defaults and honors overrides", async () => {
    const p = await practice(t.db, { name: "Override Dental" });
    expect(p.name).toBe("Override Dental");
    expect(p.timezone).toBe("America/Chicago");

    const loc = await location(t.db, { practiceId: p.id });
    expect(loc.practiceId).toBe(p.id);

    const staff = await staffMember(t.db, {
      practiceId: p.id,
      locationId: loc.id,
      role: "provider",
    });
    expect(staff.role).toBe("provider");
    expect(staff.deactivatedAt).toBeNull();

    const doc = await provider(t.db, {
      practiceId: p.id,
      locationId: loc.id,
      staffMemberId: staff.id,
    });
    expect(doc.active).toBe(true);
    expect(doc.staffMemberId).toBe(staff.id);
  });

  it("creates related rows on demand: derivation() alone builds the full graph", async () => {
    const d = await derivation(t.db);
    expect(d.basis).toBe("inferred_text");
    expect(d.confidence).toBe(0.9);
    expect(d.modelVersion).toBe("test-model-1");

    const [parent] = await t.db
      .select()
      .from(signals)
      .where(eq(signals.id, d.signalId));
    expect(parent?.practiceId).toBe(d.practiceId);
    expect(parent?.sourceKind).toBe("manual");
    expect(parent?.sourceId).toBeNull();
  });

  it("derivation({ basis: 'manual' }) nulls model_version by convention", async () => {
    const d = await derivation(t.db, { basis: "manual", confidence: 1 });
    expect(d.modelVersion).toBeNull();
  });

  it("consent() goes through grantConsent — versions are assigned, not hand-rolled", async () => {
    const s = await signal(t.db);
    const v1 = await consent(t.db, { signalId: s.id });
    expect(v1.consentVersion).toBe(1);
    expect(v1.channels).toEqual(["website"]);
    const v2 = await consent(t.db, {
      signalId: s.id,
      channels: ["website", "gbp"],
    });
    expect(v2.consentVersion).toBe(2);
  });

  it("patient() and contactPoint() use the encrypted write path", async () => {
    const pat = await patient(t.db);
    const cp = await contactPoint(t.db, { patientId: pat.id });
    expect(cp.patientId).toBe(pat.id);
    expect(cp.valueEncrypted).toMatch(/^v1:/);
    expect(cp.valueHash).toMatch(/^[0-9a-f]{64}$/);
    // The keyring is exported so tests can round-trip the same material.
    expect(TEST_KEYRING.currentVersion).toBe(1);

    // A second, distinct contact point for the same patient: the counter
    // keeps default values unique under the (patient, kind, hash) index.
    const cp2 = await contactPoint(t.db, { patientId: pat.id });
    expect(cp2.id).not.toBe(cp.id);
  });

  it("proofExcerpt() writes tsv via the generated column and accepts embeddings", async () => {
    const bare = await proofExcerpt(t.db, {
      excerptText: "Sedation kept my anxiety manageable.",
    });
    expect(bare.embedding).toBeNull();

    const embedded = await proofExcerpt(t.db, {
      signalId: bare.signalId,
      embedding: new Array(1024).fill(0).map((_, i) => (i === 0 ? 1 : 0)),
    });
    expect(embedded.embedding).toHaveLength(1024);

    const [row] = await t.db.execute(
      dsql`SELECT tsv FROM proof_excerpts WHERE id = ${bare.id}`,
    );
    expect((row as { tsv: string }).tsv).toContain("sedat");
  });

  it("repeated no-arg factories never collide on unique constraints", async () => {
    // clerk_org_id + slug uniqueness, and the partial unique index on
    // (practice_id, source_kind, source_id) with repeated null source_ids.
    const p1 = await practice(t.db);
    const p2 = await practice(t.db);
    expect(p1.clerkOrgId).not.toBe(p2.clerkOrgId);
    await signal(t.db, { practiceId: p1.id });
    await signal(t.db, { practiceId: p1.id });
    const rows = await t.db
      .select()
      .from(signals)
      .where(eq(signals.practiceId, p1.id));
    expect(rows).toHaveLength(2);
  });
});
