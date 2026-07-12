/**
 * The demo-practice seed (issue #32, Epic #1) — wipe-and-recreate, one
 * transaction, deterministic output.
 *
 * Composition rules:
 *
 * - **Domain logic is never bypassed.** Consents go through `grantConsent`
 *   / `revokeConsent` (versioning stays sanctioned) and contact points
 *   through `upsertContactPoint` (encrypt + hash on the one write path) —
 *   exactly like the test factories in `test/factories.ts`. Plain tables
 *   (signals, derivations, excerpts) use the Drizzle insert API directly.
 * - **Deterministic**: primary keys come from `seedId(name)`; every
 *   timestamp derives from `SEED_ANCHOR`; confidences from `seededFloat`.
 *   Two caveats, both inherent to routing through the domain helpers:
 *   consent/contact-point row ids are database-generated, and
 *   `value_encrypted` differs per run (AES-GCM uses a fresh IV) while
 *   decrypting to identical plaintexts — `value_hash` IS deterministic.
 * - **Idempotent**: the wipe deletes every practice-scoped child row and
 *   re-inserts. The practice row itself is kept and updated when it
 *   already exists, so a demo practice that has accumulated `audit_log`
 *   rows (append-only — the 0008 trigger forbids deleting them) can still
 *   be reseeded.
 * - **Scoped**: only the demo practice (found by `clerk_org_id`) is ever
 *   touched. Other data in the database is invisible to the seed.
 *
 * Embeddings: `proof_excerpts.embedding` is left NULL on purpose — the
 * embedding backfill is Epic #9's job, and the seed must not fake vectors
 * the hybrid-search code would then treat as meaningful.
 *
 * `import_runs`: the seed creates the legacy CSV import's run row (a
 * completed manual run, issue #111) and stamps its deterministic id on
 * every `csv_import` signal — the FK from `signals.import_run_id` is real
 * as of migration 0011. Seeded signals are display-ready, so every one
 * carries the terminal `pipeline_status` of `processed`.
 */

import { faker } from "@faker-js/faker";
import type { Keyring } from "@wellregarded/core";
import { eq } from "drizzle-orm";

import type { Tx } from "../audit.js";
import type { Db } from "../client.js";
import { grantConsent, revokeConsent } from "../queries/consents.js";
import { upsertContactPoint } from "../queries/patients.js";
import { consents } from "../schema/consents.js";
import { derivations } from "../schema/derivations.js";
import { importDrafts } from "../schema/importDrafts.js";
import { importRuns } from "../schema/importRuns.js";
import { contactPoints, patients } from "../schema/pii.js";
import { proofExcerpts } from "../schema/proofExcerpts.js";
import { responses } from "../schema/responses.js";
import { signals } from "../schema/signals.js";
import {
  locations,
  practices,
  providers,
  staffMembers,
} from "../schema/tenancy.js";
import {
  DEMO_IMPORT_ARTIFACT_KEY,
  DEMO_IMPORT_DAYS_AGO,
  DEMO_IMPORT_RUN_KEY,
  DEMO_PRACTICE_CLERK_ORG_ID,
  DEMO_PRACTICE_SLUG,
  daysBeforeAnchor,
  SEED_FAKER_SEED,
} from "./constants.js";
import { devKeyring } from "./devKeyring.js";
import {
  DEMO_PRACTICE,
  LOCATION_FIXTURES,
  PATIENT_FIXTURES,
  PROVIDER_FIXTURES,
  STAFF_FIXTURES,
} from "./fixtures/demoPractice.js";
import {
  demoGoogleArtifactKey,
  demoGoogleReviewName,
} from "./fixtures/googleArtifacts.js";
import { SIGNAL_FIXTURES, type SignalFixture } from "./fixtures/signals.js";
import { seededFloat, seededInt, seedId } from "./ids.js";

export const DEMO_PRACTICE_ID = seedId("practice:cedar-ridge-dental");
export const DEMO_IMPORT_RUN_ID = seedId(DEMO_IMPORT_RUN_KEY);

export interface SeedSummary {
  practiceId: string;
  locations: number;
  providers: number;
  staffMembers: number;
  patients: number;
  contactPoints: number;
  signals: number;
  derivations: number;
  consents: number;
  proofExcerpts: number;
  importRuns: number;
  /** Imported pre-existing Google owner replies (#214). */
  responses: number;
}

export interface RunSeedOptions {
  /** Defaults to the committed dev keyring (see ./devKeyring.ts). */
  keyring?: Keyring;
}

/**
 * Wipe and recreate the demo practice. Runs inside a single transaction —
 * a mid-seed failure can never leave a half-seeded practice.
 */
export async function runSeed(
  db: Db,
  options: RunSeedOptions = {},
): Promise<SeedSummary> {
  const keyring = options.keyring ?? devKeyring();
  // Fixed faker seed (requirement 2). Narratives are hand-committed; faker
  // fills only incidental values, deterministically.
  faker.seed(SEED_FAKER_SEED);

  return db.transaction(async (tx) => {
    const practiceId = await upsertPractice(tx);
    const locationIds = await insertLocations(tx, practiceId);
    const staffIds = await insertStaff(tx, practiceId, locationIds);
    const providerIds = await insertProviders(
      tx,
      practiceId,
      locationIds,
      staffIds,
    );
    const { patientIds, contactPointCount } = await insertPatients(
      tx,
      practiceId,
      keyring,
    );
    const importRunCount = await insertImportRuns(tx, practiceId);
    const signalIds = await insertSignals(
      tx,
      practiceId,
      locationIds,
      providerIds,
      patientIds,
    );
    const derivationCount = await insertDerivations(tx, practiceId, signalIds);
    const consentCount = await insertConsents(
      tx,
      practiceId,
      signalIds,
      patientIds,
    );
    const excerptCount = await insertProofExcerpts(tx, practiceId, signalIds);
    const responseCount = await insertImportedResponses(
      tx,
      practiceId,
      signalIds,
    );

    return {
      practiceId,
      locations: LOCATION_FIXTURES.length,
      providers: PROVIDER_FIXTURES.length,
      staffMembers: STAFF_FIXTURES.length,
      patients: PATIENT_FIXTURES.length,
      contactPoints: contactPointCount,
      signals: SIGNAL_FIXTURES.length,
      derivations: derivationCount,
      consents: consentCount,
      proofExcerpts: excerptCount,
      importRuns: importRunCount,
      responses: responseCount,
    };
  });
}

/**
 * Delete every practice-scoped child row (FK order: signal children →
 * signals → providers → staff → patients → locations), then insert or
 * update the practice row itself. The practice row is never deleted once
 * it exists — `audit_log` rows are append-only and FK the practice, so a
 * delete would fail on any database where the app has written audit rows.
 */
async function upsertPractice(tx: Tx): Promise<string> {
  const [existing] = await tx
    .select({ id: practices.id })
    .from(practices)
    .where(eq(practices.clerkOrgId, DEMO_PRACTICE_CLERK_ORG_ID));

  const fields = {
    name: DEMO_PRACTICE.name,
    slug: DEMO_PRACTICE_SLUG,
    timezone: DEMO_PRACTICE.timezone,
    websiteUrl: DEMO_PRACTICE.websiteUrl,
    phone: DEMO_PRACTICE.phone,
  };

  if (!existing) {
    await tx.insert(practices).values({
      id: DEMO_PRACTICE_ID,
      clerkOrgId: DEMO_PRACTICE_CLERK_ORG_ID,
      ...fields,
    });
    return DEMO_PRACTICE_ID;
  }

  const practiceId = existing.id;
  // Children first — order respects every FK into and out of each table.
  await tx
    .delete(proofExcerpts)
    .where(eq(proofExcerpts.practiceId, practiceId));
  await tx.delete(derivations).where(eq(derivations.practiceId, practiceId));
  await tx.delete(consents).where(eq(consents.practiceId, practiceId));
  // Responses FK both signals and staff_members — delete before either.
  await tx.delete(responses).where(eq(responses.practiceId, practiceId));
  await tx.delete(signals).where(eq(signals.practiceId, practiceId));
  // Import drafts (CSV wizard state accumulated during dev, Epic #8) FK
  // import_runs and staff_members — delete before both, or reseeding any
  // database that has been used for imports fails on the FK.
  await tx.delete(importDrafts).where(eq(importDrafts.practiceId, practiceId));
  await tx.delete(importRuns).where(eq(importRuns.practiceId, practiceId));
  await tx.delete(providers).where(eq(providers.practiceId, practiceId));
  await tx.delete(staffMembers).where(eq(staffMembers.practiceId, practiceId));
  // pii.contact_points cascades from its patient.
  await tx.delete(patients).where(eq(patients.practiceId, practiceId));
  await tx.delete(locations).where(eq(locations.practiceId, practiceId));
  await tx.update(practices).set(fields).where(eq(practices.id, practiceId));
  return practiceId;
}

async function insertLocations(
  tx: Tx,
  practiceId: string,
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const fixture of LOCATION_FIXTURES) {
    ids[fixture.key] = seedId(`location:${fixture.key}`);
  }
  await tx.insert(locations).values(
    LOCATION_FIXTURES.map((fixture) => ({
      id: ids[fixture.key],
      practiceId,
      name: fixture.name,
      addressLine1: fixture.addressLine1,
      city: fixture.city,
      state: fixture.state,
      postalCode: fixture.postalCode,
      googlePlaceId: fixture.googlePlaceId,
      phone: fixture.phone,
    })),
  );
  return ids;
}

async function insertStaff(
  tx: Tx,
  practiceId: string,
  locationIds: Record<string, string>,
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const fixture of STAFF_FIXTURES) {
    ids[fixture.key] = seedId(`staff:${fixture.key}`);
  }
  await tx.insert(staffMembers).values(
    STAFF_FIXTURES.map((fixture) => ({
      id: ids[fixture.key],
      practiceId,
      clerkUserId: `user_demo_${fixture.key}`,
      role: fixture.role,
      locationId: fixture.location ? locationIds[fixture.location] : null,
      email: fixture.email,
      displayName: fixture.displayName,
    })),
  );
  return ids;
}

async function insertProviders(
  tx: Tx,
  practiceId: string,
  locationIds: Record<string, string>,
  staffIds: Record<string, string>,
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const fixture of PROVIDER_FIXTURES) {
    ids[fixture.key] = seedId(`provider:${fixture.key}`);
  }
  await tx.insert(providers).values(
    PROVIDER_FIXTURES.map((fixture) => ({
      id: ids[fixture.key],
      practiceId,
      locationId: locationIds[fixture.location],
      displayName: fixture.displayName,
      fullName: fixture.fullName,
      credentials: fixture.credentials,
      bio: fixture.bio,
      staffMemberId: fixture.staffMember ? staffIds[fixture.staffMember] : null,
    })),
  );
  return ids;
}

async function insertPatients(
  tx: Tx,
  practiceId: string,
  keyring: Keyring,
): Promise<{ patientIds: Record<string, string>; contactPointCount: number }> {
  const patientIds: Record<string, string> = {};
  for (const fixture of PATIENT_FIXTURES) {
    patientIds[fixture.key] = seedId(`patient:${fixture.key}`);
  }
  await tx.insert(patients).values(
    PATIENT_FIXTURES.map((fixture) => ({
      id: patientIds[fixture.key],
      practiceId,
      displayName: fixture.displayName,
      // Plausible PMS provenance; faker output is deterministic under the
      // fixed seed as long as the pinned faker major stays put.
      externalRefs: {
        opendental_pat_num: faker.number.int({ min: 1000, max: 99999 }),
      },
    })),
  );

  let contactPointCount = 0;
  for (const fixture of PATIENT_FIXTURES) {
    const patientId = patientIds[fixture.key];
    if (!patientId) continue;
    for (const contact of fixture.contactPoints) {
      // The sanctioned write path: encrypt + hash inside the helper. The
      // plaintext never reaches the database.
      const row = await upsertContactPoint(tx, {
        patientId,
        kind: contact.kind,
        rawValue: contact.rawValue,
        keyring,
        ...(contact.consentHint ? { consentHint: contact.consentHint } : {}),
      });
      if (contact.optedOutDaysAgo !== undefined) {
        await tx
          .update(contactPoints)
          .set({ optedOutAt: daysBeforeAnchor(contact.optedOutDaysAgo) })
          .where(eq(contactPoints.id, row.id));
      }
      contactPointCount++;
    }
  }
  return { patientIds, contactPointCount };
}

/** `occurred_at`: anchor − daysAgo, ± a few deterministic hours. */
function occurredAt(fixture: SignalFixture): Date {
  return daysBeforeAnchor(fixture.daysAgo, seededInt(fixture.key, 10) - 5);
}

/** Signals are ingested shortly after they occur (CSV rows at import time). */
function ingestedAt(fixture: SignalFixture): Date {
  if (fixture.sourceKind === "csv_import") {
    // At import time — the day the legacy run ran (see insertImportRuns).
    return daysBeforeAnchor(DEMO_IMPORT_DAYS_AGO);
  }
  return new Date(occurredAt(fixture).getTime() + 6 * 3600_000);
}

function provenance(fixture: SignalFixture): {
  sourceId: string | null;
  sourceUrl: string | null;
  rawArtifactKey: string | null;
  importRunId: string | null;
} {
  switch (fixture.sourceKind) {
    case "google":
      return {
        // A REAL v4 review resource name (seed v3, #214): `source_id` IS
        // the GBP resource name for the publish/reply flows, and the demo
        // raw artifact's review `name` must match it byte-for-byte (see
        // ./fixtures/googleArtifacts.ts).
        sourceId: demoGoogleReviewName(fixture),
        sourceUrl: `https://search.google.com/local/reviews/demo/${fixture.key}`,
        rawArtifactKey: demoGoogleArtifactKey(fixture),
        importRunId: null,
      };
    case "csv_import":
      return {
        sourceId: `legacy-feedback-${fixture.key}`,
        sourceUrl: null,
        rawArtifactKey: DEMO_IMPORT_ARTIFACT_KEY,
        importRunId: DEMO_IMPORT_RUN_ID,
      };
    case "firstparty":
      return {
        sourceId: `post-visit-${fixture.key}`,
        sourceUrl: null,
        rawArtifactKey: `raw/firstparty/demo/${fixture.key}.json`,
        importRunId: null,
      };
    case "email":
      return {
        sourceId: `email-${fixture.key}`,
        sourceUrl: null,
        rawArtifactKey: `raw/email/demo/${fixture.key}.eml`,
        importRunId: null,
      };
    default:
      // Manual entry has no source-native identity.
      return {
        sourceId: null,
        sourceUrl: null,
        rawArtifactKey: null,
        importRunId: null,
      };
  }
}

/**
 * The legacy CSV import's `import_runs` row (issue #111): a completed
 * manual run that created the 12 `csv_import` signals, finished the day it
 * ran, with the raw export's R2 key on record. Inserted before signals —
 * `signals.import_run_id` FKs it.
 */
async function insertImportRuns(tx: Tx, practiceId: string): Promise<number> {
  const started = daysBeforeAnchor(DEMO_IMPORT_DAYS_AGO);
  const csvCount = SIGNAL_FIXTURES.filter(
    (fixture) => fixture.sourceKind === "csv_import",
  ).length;
  await tx.insert(importRuns).values({
    id: DEMO_IMPORT_RUN_ID,
    practiceId,
    sourceKind: "csv_import",
    trigger: "manual",
    status: "completed",
    startedAt: started,
    // The legacy import took a couple of minutes, deterministically.
    finishedAt: new Date(started.getTime() + 2 * 60_000),
    created: csvCount,
    merged: 0,
    skipped: 0,
    failed: 0,
    stats: {},
    errorSamples: [],
    rawArtifactKeys: [DEMO_IMPORT_ARTIFACT_KEY],
  });
  return 1;
}

async function insertSignals(
  tx: Tx,
  practiceId: string,
  locationIds: Record<string, string>,
  providerIds: Record<string, string>,
  patientIds: Record<string, string>,
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const fixture of SIGNAL_FIXTURES) {
    ids[fixture.key] = seedId(`signal:${fixture.key}`);
  }
  await tx.insert(signals).values(
    SIGNAL_FIXTURES.map((fixture) => {
      const created = ingestedAt(fixture);
      return {
        id: ids[fixture.key],
        practiceId,
        patientId: fixture.patient ? patientIds[fixture.patient] : null,
        locationId: fixture.location ? locationIds[fixture.location] : null,
        providerId: fixture.provider ? providerIds[fixture.provider] : null,
        sourceKind: fixture.sourceKind,
        occurredAt: occurredAt(fixture),
        originalText: fixture.text,
        originalRating: fixture.rating ?? null,
        visibility: fixture.visibility,
        // Seeded signals are display-ready — the terminal pipeline state.
        pipelineStatus: "processed" as const,
        availability: fixture.deletedAtSource
          ? ("deleted_at_source" as const)
          : ("available" as const),
        createdAt: created,
        updatedAt: created,
        ...provenance(fixture),
      };
    }),
  );
  return ids;
}

async function insertDerivations(
  tx: Tx,
  practiceId: string,
  signalIds: Record<string, string>,
): Promise<number> {
  type DerivationInsert = typeof derivations.$inferInsert;
  const rows: DerivationInsert[] = [];

  for (const fixture of SIGNAL_FIXTURES) {
    const signalId = signalIds[fixture.key];
    if (!signalId) continue;
    // Classification runs shortly after ingest; manual corrections later.
    const classifiedAt = new Date(
      occurredAt(fixture).getTime() + 24 * 3600_000,
    );
    const correctedAt = new Date(
      occurredAt(fixture).getTime() + 3 * 24 * 3600_000,
    );

    const push = (
      dimension: DerivationInsert["dimension"],
      value: unknown,
      basis: DerivationInsert["basis"],
      confidence: number,
      createdAt: Date,
    ) => {
      rows.push({
        id: seedId(`derivation:${fixture.key}:${dimension}:${basis}`),
        signalId,
        practiceId,
        dimension,
        value,
        confidence,
        basis,
        // Required-by-convention for non-manual bases; NULL for manual.
        modelVersion: basis === "manual" ? null : "seed-fixture",
        createdAt,
      });
    };

    // Sentiment — Google's star rating is source metadata; everything else
    // is inferred from text.
    if (fixture.sourceKind === "google" && fixture.rating !== undefined) {
      push(
        "sentiment",
        fixture.sentiment,
        "source_metadata",
        seededFloat(`${fixture.key}:sentiment`, 0.95, 0.99),
        classifiedAt,
      );
    } else {
      push(
        "sentiment",
        fixture.sentiment,
        "inferred_text",
        seededFloat(`${fixture.key}:sentiment`, 0.62, 0.97),
        classifiedAt,
      );
    }
    // A human re-read some of these — the manual row supersedes (manual
    // outranks inferred regardless of recency, but we date it later anyway).
    if (fixture.manualSentiment) {
      push("sentiment", fixture.manualSentiment, "manual", 1, correctedAt);
    }

    // Urgency — the Tuesday-wait cluster is judged from sibling signals
    // (`inferred_related`); everything else from the text itself.
    push(
      "urgency",
      fixture.urgency ?? "low",
      fixture.urgencyFromRelated ? "inferred_related" : "inferred_text",
      fixture.urgencyFromRelated
        ? seededFloat(`${fixture.key}:urgency`, 0.6, 0.8)
        : seededFloat(`${fixture.key}:urgency`, 0.55, 0.95),
      classifiedAt,
    );

    if (fixture.responseRisk) {
      push(
        "response_risk",
        fixture.responseRisk,
        "inferred_text",
        seededFloat(`${fixture.key}:response_risk`, 0.6, 0.95),
        classifiedAt,
      );
    }

    if (fixture.publicationSuitability) {
      push(
        "publication_suitability",
        fixture.publicationSuitability,
        "inferred_text",
        seededFloat(`${fixture.key}:publication_suitability`, 0.7, 0.95),
        classifiedAt,
      );
    }
  }

  await tx.insert(derivations).values(rows);
  return rows.length;
}

async function insertConsents(
  tx: Tx,
  practiceId: string,
  signalIds: Record<string, string>,
  patientIds: Record<string, string>,
): Promise<number> {
  let count = 0;
  for (const fixture of SIGNAL_FIXTURES) {
    if (!fixture.consent) continue;
    const signalId = signalIds[fixture.key];
    if (!signalId) continue;

    for (const grant of fixture.consent.grants) {
      // Through grantConsent — consent_version assignment stays sanctioned.
      await grantConsent(tx, {
        practiceId,
        signalId,
        patientId: fixture.patient
          ? (patientIds[fixture.patient] ?? null)
          : null,
        channels: grant.channels,
        attribution: grant.attribution,
        allowMinorEdits: grant.allowMinorEdits ?? false,
        grantedAt: daysBeforeAnchor(grant.grantedDaysAgo),
        source: grant.source,
        expiresAt:
          grant.expiresDaysAgo !== undefined
            ? daysBeforeAnchor(grant.expiresDaysAgo)
            : null,
      });
      count++;
    }
    if (fixture.consent.revokedDaysAgo !== undefined) {
      await revokeConsent(
        tx,
        signalId,
        daysBeforeAnchor(fixture.consent.revokedDaysAgo),
      );
    }
  }
  return count;
}

async function insertProofExcerpts(
  tx: Tx,
  practiceId: string,
  signalIds: Record<string, string>,
): Promise<number> {
  type ExcerptInsert = typeof proofExcerpts.$inferInsert;
  const rows: ExcerptInsert[] = [];
  for (const fixture of SIGNAL_FIXTURES) {
    if (!fixture.excerpts) continue;
    const signalId = signalIds[fixture.key];
    if (!signalId) continue;
    fixture.excerpts.forEach((excerpt, index) => {
      rows.push({
        id: seedId(`excerpt:${fixture.key}:${index}`),
        signalId,
        practiceId,
        excerptText: excerpt.text,
        // NULL on purpose: embedding backfill is Epic #9's job. The seed
        // must not invent vectors hybrid search would treat as real.
        embedding: null,
        topics: excerpt.topics,
        createdAt: new Date(occurredAt(fixture).getTime() + 2 * 24 * 3600_000),
      });
    });
  }
  await tx.insert(proofExcerpts).values(rows);
  return rows.length;
}

/**
 * Imported pre-existing Google owner replies (issue #214): fixtures with
 * an `existingReply` get the exact row the normalize seam /
 * reply-import backfill would write — `origin = 'source_import'`,
 * `status = 'published'`, no staff author, moderation state carried,
 * `published_at` = the reply's Google updateTime. Direct insert (a plain
 * table, per the composition rules) with deterministic ids; timestamps
 * mirror the reply time so the #77 thread orders sensibly.
 */
async function insertImportedResponses(
  tx: Tx,
  practiceId: string,
  signalIds: Record<string, string>,
): Promise<number> {
  type ResponseInsert = typeof responses.$inferInsert;
  const rows: ResponseInsert[] = [];
  for (const fixture of SIGNAL_FIXTURES) {
    const reply = fixture.existingReply;
    const signalId = signalIds[fixture.key];
    if (reply === undefined || signalId === undefined) continue;
    const repliedAt = daysBeforeAnchor(reply.updatedDaysAgo);
    rows.push({
      id: seedId(`response:${fixture.key}:imported`),
      practiceId,
      signalId,
      authorId: null,
      origin: "source_import",
      status: "published",
      body: reply.comment,
      moderationState: reply.state,
      policyViolation: reply.policyViolation ?? null,
      publishedAt: repliedAt,
      publishUpdateTime: repliedAt.toISOString(),
      createdAt: repliedAt,
      updatedAt: repliedAt,
    });
  }
  if (rows.length > 0) {
    await tx.insert(responses).values(rows);
  }
  return rows.length;
}
