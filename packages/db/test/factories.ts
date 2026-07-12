/**
 * Row factories for integration tests (issue #49, Epic #3).
 *
 * Each factory takes a `Db` and `Partial<Insert...>` overrides, fills the
 * rest with sensible defaults, INSERTs a real row (the entire point is
 * exercising constraints and triggers — no in-memory fakes), and returns
 * the full selected row. Related rows are created on demand: `signal(db)`
 * with no `practiceId` creates a practice first.
 *
 * Deterministic data: faker is seeded per test file by `setupTestDb()`
 * (see `./harness.js`), so failures reproduce. Where the schema demands
 * uniqueness (`clerk_org_id`, `slug`, `(practice_id, source_kind,
 * source_id)`, contact-point hashes) the defaults combine faker output
 * with a monotonic counter — never `Math.random()`.
 *
 * TODO(Epic #15): add `recoveryItem()` when the `recovery_items` table
 * lands — it does not exist in the schema yet.
 */

import { faker } from "@faker-js/faker";
import {
  createKeyring,
  encryptField,
  generateApiKey,
} from "@wellregarded/core";
import { eq } from "drizzle-orm";

import type { Db } from "../src/client.js";
import {
  type Consent,
  type GrantConsentInput,
  grantConsent,
} from "../src/queries/consents.js";
import {
  type ContactPoint,
  type Patient,
  type UpsertContactPointInput,
  upsertContactPoint,
} from "../src/queries/patients.js";
import { apiKeys } from "../src/schema/apiKeys.js";
import { derivations } from "../src/schema/derivations.js";
import { importDrafts } from "../src/schema/importDrafts.js";
import { importRuns } from "../src/schema/importRuns.js";
import { patients } from "../src/schema/pii.js";
import { proofExcerpts } from "../src/schema/proofExcerpts.js";
import { signals } from "../src/schema/signals.js";
import { sourceConnections } from "../src/schema/sourceConnections.js";
import {
  locations,
  practices,
  providers,
  staffMembers,
} from "../src/schema/tenancy.js";

/**
 * Test-only key material — base64 of readable 32-byte strings, computed at
 * runtime so no secret-shaped literal sits in the repo; never real
 * secrets. Used by `contactPoint()` and `sourceConnection()`, and exported
 * (raw input too — worker tests feed it through env vars) so tests can
 * decrypt/hash the same values.
 */
export const TEST_KEYRING_INPUT = {
  encryptionKeys: { "1": btoa("test-only-pii-encryption-key-32b") },
  hashKey: btoa("test-only-pii-hash-hmac-key-32b!"),
};
export const TEST_KEYRING = createKeyring(TEST_KEYRING_INPUT);

/**
 * Monotonic per-process counter — the uniqueness component of every
 * default that a constraint requires to be unique. Never reset (unlike the
 * faker seed): two rows in one database must never collide even though
 * faker repeats across files.
 */
let seq = 0;
function nextSeq(): number {
  return ++seq;
}

function must<T>(row: T | undefined, what: string): T {
  if (!row) throw new Error(`${what} insert returned no row`);
  return row;
}

type ApiKeyInsert = typeof apiKeys.$inferInsert;
type ImportDraftInsert = typeof importDrafts.$inferInsert;
type ImportRunInsert = typeof importRuns.$inferInsert;
type PracticeInsert = typeof practices.$inferInsert;
type LocationInsert = typeof locations.$inferInsert;
type StaffMemberInsert = typeof staffMembers.$inferInsert;
type ProviderInsert = typeof providers.$inferInsert;
type SignalInsert = typeof signals.$inferInsert;
type SourceConnectionInsert = typeof sourceConnections.$inferInsert;
type DerivationInsert = typeof derivations.$inferInsert;
type PatientInsert = typeof patients.$inferInsert;
type ProofExcerptInsert = typeof proofExcerpts.$inferInsert;

export async function practice(
  db: Db,
  overrides: Partial<PracticeInsert> = {},
): Promise<typeof practices.$inferSelect> {
  const n = nextSeq();
  const [row] = await db
    .insert(practices)
    .values({
      clerkOrgId: `org_test_${n}`,
      name: `${faker.company.name()} Dental`,
      slug: `test-practice-${n}`,
      ...overrides,
    })
    .returning();
  return must(row, "practice");
}

/**
 * Inserts an `api_keys` row backed by a real generated key. `keyHash` and
 * `last4` cannot be overridden — they are derived from the generated
 * plaintext, which is returned as the extra `key` property (not a column;
 * the DB never stores it) so tests can present the credential.
 */
export async function apiKey(
  db: Db,
  overrides: Partial<Omit<ApiKeyInsert, "keyHash" | "last4">> = {},
): Promise<typeof apiKeys.$inferSelect & { key: string }> {
  const n = nextSeq();
  const practiceId = overrides.practiceId ?? (await practice(db)).id;
  const environment = overrides.environment ?? "live";
  const generated = await generateApiKey(environment);
  const [row] = await db
    .insert(apiKeys)
    .values({
      name: `Test key ${n}`,
      ...overrides,
      practiceId,
      environment,
      keyHash: generated.hash,
      last4: generated.last4,
    })
    .returning();
  return { ...must(row, "api key"), key: generated.key };
}

export async function importRun(
  db: Db,
  overrides: Partial<ImportRunInsert> = {},
): Promise<typeof importRuns.$inferSelect> {
  const practiceId = overrides.practiceId ?? (await practice(db)).id;
  const [row] = await db
    .insert(importRuns)
    .values({
      sourceKind: "csv_import",
      trigger: "manual",
      ...overrides,
      practiceId,
    })
    .returning();
  return must(row, "import run");
}

/**
 * Inserts an `import_drafts` row (issue #133/#135). Defaults to a
 * `confirmed` draft with a two-column mapping — what the import Workflow
 * consumes — creating the practice and uploading staff member on demand.
 */
export async function importDraft(
  db: Db,
  overrides: Partial<ImportDraftInsert> = {},
): Promise<typeof importDrafts.$inferSelect> {
  const n = nextSeq();
  const practiceId = overrides.practiceId ?? (await practice(db)).id;
  const createdBy =
    overrides.createdBy ?? (await staffMember(db, { practiceId })).id;
  const [row] = await db
    .insert(importDrafts)
    .values({
      r2Key: `${practiceId}/imports/${"0".repeat(63)}${n % 10}.csv`,
      originalFilename: `export-${n}.csv`,
      byteSize: 1024,
      headers: ["Date", "Review"],
      mapping: {
        occurredAt: { column: "Date", dateFormat: "ISO" },
        text: { column: "Review" },
      },
      status: "confirmed",
      ...overrides,
      practiceId,
      createdBy,
    })
    .returning();
  return must(row, "import draft");
}

export async function location(
  db: Db,
  overrides: Partial<LocationInsert> = {},
): Promise<typeof locations.$inferSelect> {
  const practiceId = overrides.practiceId ?? (await practice(db)).id;
  const [row] = await db
    .insert(locations)
    .values({
      name: faker.location.city(),
      ...overrides,
      practiceId,
    })
    .returning();
  return must(row, "location");
}

export async function staffMember(
  db: Db,
  overrides: Partial<StaffMemberInsert> = {},
): Promise<typeof staffMembers.$inferSelect> {
  const n = nextSeq();
  const practiceId = overrides.practiceId ?? (await practice(db)).id;
  const [row] = await db
    .insert(staffMembers)
    .values({
      clerkUserId: `user_test_${n}`,
      email: `staff-${n}@example.com`,
      displayName: faker.person.fullName(),
      ...overrides,
      practiceId,
    })
    .returning();
  return must(row, "staff member");
}

/**
 * Inserts a `source_connections` row (issue #118). The default
 * `encryptedCredentials` is real `encryptField` output over a fake refresh
 * token using `TEST_KEYRING`, so decrypt paths work in tests. Creates the
 * practice (and a connecting staff member) on demand.
 */
export async function sourceConnection(
  db: Db,
  overrides: Partial<SourceConnectionInsert> = {},
): Promise<typeof sourceConnections.$inferSelect> {
  const n = nextSeq();
  const practiceId = overrides.practiceId ?? (await practice(db)).id;
  const connectedBy =
    overrides.connectedBy ?? (await staffMember(db, { practiceId })).id;
  const encryptedCredentials =
    overrides.encryptedCredentials !== undefined
      ? overrides.encryptedCredentials
      : await encryptField(
          JSON.stringify({
            refreshToken: `test-refresh-token-${n}`,
            obtainedAt: new Date().toISOString(),
          }),
          TEST_KEYRING,
        );
  const [row] = await db
    .insert(sourceConnections)
    .values({
      kind: "google",
      scopes: ["https://www.googleapis.com/auth/business.manage"],
      ...overrides,
      practiceId,
      connectedBy,
      encryptedCredentials,
    })
    .returning();
  return must(row, "source connection");
}

export async function provider(
  db: Db,
  overrides: Partial<ProviderInsert> = {},
): Promise<typeof providers.$inferSelect> {
  const practiceId = overrides.practiceId ?? (await practice(db)).id;
  const [row] = await db
    .insert(providers)
    .values({
      displayName: `Dr. ${faker.person.lastName()}`,
      credentials: "DDS",
      ...overrides,
      practiceId,
    })
    .returning();
  return must(row, "provider");
}

export async function signal(
  db: Db,
  overrides: Partial<SignalInsert> = {},
): Promise<typeof signals.$inferSelect> {
  const practiceId = overrides.practiceId ?? (await practice(db)).id;
  const [row] = await db
    .insert(signals)
    .values({
      sourceKind: "manual",
      // Manual entry has no source-native id; sources that do get a unique
      // one from the caller (the partial unique index ignores nulls).
      sourceId: null,
      occurredAt: new Date(),
      originalText: faker.lorem.sentence(),
      visibility: "private",
      ...overrides,
      practiceId,
    })
    .returning();
  return must(row, "signal");
}

export async function derivation(
  db: Db,
  overrides: Partial<DerivationInsert> = {},
): Promise<typeof derivations.$inferSelect> {
  const { signalId, practiceId } = await resolveSignalScope(db, overrides);
  const basis = overrides.basis ?? "inferred_text";
  const [row] = await db
    .insert(derivations)
    .values({
      dimension: "sentiment",
      value: "positive",
      confidence: 0.9,
      // Required-by-convention for inferred bases; NULL for manual.
      modelVersion: basis === "manual" ? null : "test-model-1",
      ...overrides,
      basis,
      signalId,
      practiceId,
    })
    .returning();
  return must(row, "derivation");
}

/**
 * Grants consent through `grantConsent` (never a raw INSERT), so
 * `consent_version` is assigned the sanctioned way.
 */
export async function consent(
  db: Db,
  overrides: Partial<GrantConsentInput> = {},
): Promise<Consent> {
  const { signalId, practiceId } = await resolveSignalScope(db, overrides);
  return grantConsent(db, {
    channels: ["website"],
    attribution: "first_name",
    grantedAt: new Date(),
    source: "patient_link",
    ...overrides,
    signalId,
    practiceId,
  });
}

export async function patient(
  db: Db,
  overrides: Partial<PatientInsert> = {},
): Promise<Patient> {
  const practiceId = overrides.practiceId ?? (await practice(db)).id;
  const [row] = await db
    .insert(patients)
    .values({
      displayName: faker.person.fullName(),
      ...overrides,
      practiceId,
    })
    .returning();
  return must(row, "patient");
}

/**
 * Inserts through `upsertContactPoint` (never a raw INSERT), so the value
 * is encrypted and hashed by the sanctioned write path. Overrides take the
 * helper's input shape (`rawValue`, not `valueEncrypted`); the keyring
 * defaults to `TEST_KEYRING`.
 */
export async function contactPoint(
  db: Db,
  overrides: Partial<UpsertContactPointInput> = {},
): Promise<ContactPoint> {
  const n = nextSeq();
  const patientId = overrides.patientId ?? (await patient(db)).id;
  const kind = overrides.kind ?? "email";
  const rawValue =
    overrides.rawValue ??
    (kind === "email"
      ? `contact-${n}@example.com`
      : `+1555${String(n).padStart(7, "0")}`);
  return upsertContactPoint(db, {
    keyring: TEST_KEYRING,
    ...overrides,
    patientId,
    kind,
    rawValue,
  });
}

export async function proofExcerpt(
  db: Db,
  overrides: Partial<ProofExcerptInsert> = {},
): Promise<typeof proofExcerpts.$inferSelect> {
  const { signalId, practiceId } = await resolveSignalScope(db, overrides);
  const [row] = await db
    .insert(proofExcerpts)
    .values({
      excerptText: faker.lorem.sentence(),
      // NULL by default — excerpt rows exist before the embedding job
      // (Epic #9) fills them in. Pass a 1024-dim array to override.
      embedding: null,
      ...overrides,
      signalId,
      practiceId,
    })
    .returning();
  return must(row, "proof excerpt");
}

/**
 * Signal-scoped tables (derivations, consents, proof_excerpts) need a
 * consistent `(signalId, practiceId)` pair: create a signal on demand, or
 * — when only `signalId` was given — read the signal's practice so the
 * denormalized `practice_id` never contradicts the parent row.
 */
async function resolveSignalScope(
  db: Db,
  overrides: { signalId?: string; practiceId?: string },
): Promise<{ signalId: string; practiceId: string }> {
  if (!overrides.signalId) {
    const parent = await signal(
      db,
      overrides.practiceId ? { practiceId: overrides.practiceId } : {},
    );
    return { signalId: parent.id, practiceId: parent.practiceId };
  }
  if (overrides.practiceId) {
    return { signalId: overrides.signalId, practiceId: overrides.practiceId };
  }
  const [parent] = await db
    .select({ practiceId: signals.practiceId })
    .from(signals)
    .where(eq(signals.id, overrides.signalId));
  if (!parent) {
    throw new Error(`signal ${overrides.signalId} not found`);
  }
  return { signalId: overrides.signalId, practiceId: parent.practiceId };
}
