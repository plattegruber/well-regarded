/**
 * Integration coverage for the demo seed (issue #32): shape invariants,
 * consent-state coverage, encrypted contact round-trip, determinism, and
 * idempotency — all against a real Postgres via the template-database
 * harness.
 */

import {
  decryptField,
  hashField,
  STARTER_RESPONSE_TEMPLATES,
} from "@wellregarded/core";
import { count, eq, isNull, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { setupTestDb } from "../../test/harness.js";
import { isPublishable } from "../queries/consents.js";
import { getImportRunSummary } from "../queries/importRuns.js";
import { findContactPoint } from "../queries/patients.js";
import { consents } from "../schema/consents.js";
import { derivations } from "../schema/derivations.js";
import { contactPoints, patients } from "../schema/pii.js";
import { proofExcerpts } from "../schema/proofExcerpts.js";
import { responses } from "../schema/responses.js";
import { responseTemplates } from "../schema/responseTemplates.js";
import { signals } from "../schema/signals.js";
import {
  locations,
  practices,
  providers,
  staffMembers,
} from "../schema/tenancy.js";
import {
  DEMO_IMPORT_ARTIFACT_KEY,
  DEMO_PRACTICE_CLERK_ORG_ID,
} from "./constants.js";
import { devKeyring } from "./devKeyring.js";
import {
  LOCATION_FIXTURES,
  PATIENT_FIXTURES,
  PROVIDER_FIXTURES,
  STAFF_FIXTURES,
} from "./fixtures/demoPractice.js";
import { demoGoogleReviewName } from "./fixtures/googleArtifacts.js";
import { SIGNAL_FIXTURES } from "./fixtures/signals.js";
import { seedId } from "./ids.js";
import { DEMO_IMPORT_RUN_ID, runSeed, type SeedSummary } from "./run.js";

const t = setupTestDb();

/** Expectations derive from the fixtures — the fixture array is the contract. */
const EXPECTED_SIGNALS_BY_KIND = SIGNAL_FIXTURES.reduce<Record<string, number>>(
  (acc, fixture) => {
    acc[fixture.sourceKind] = (acc[fixture.sourceKind] ?? 0) + 1;
    return acc;
  },
  {},
);
// A revocation is a consent row too (issue #84: revocations are new
// version rows, never UPDATEs), so revoked fixtures count one extra.
const EXPECTED_CONSENT_ROWS = SIGNAL_FIXTURES.reduce(
  (total, fixture) =>
    total +
    (fixture.consent?.grants.length ?? 0) +
    (fixture.consent?.revokedDaysAgo !== undefined ? 1 : 0),
  0,
);
const EXPECTED_EXCERPTS = SIGNAL_FIXTURES.reduce(
  (total, fixture) => total + (fixture.excerpts?.length ?? 0),
  0,
);
const REPLIED_FIXTURES = SIGNAL_FIXTURES.filter(
  (fixture) => fixture.existingReply !== undefined,
);

async function tableCounts(summary: SeedSummary) {
  const one = async (query: Promise<{ n: number }[]>) => {
    const [row] = await query;
    return row?.n ?? -1;
  };
  const { practiceId } = summary;
  return {
    locations: await one(
      t.db
        .select({ n: count() })
        .from(locations)
        .where(eq(locations.practiceId, practiceId)),
    ),
    providers: await one(
      t.db
        .select({ n: count() })
        .from(providers)
        .where(eq(providers.practiceId, practiceId)),
    ),
    staff: await one(
      t.db
        .select({ n: count() })
        .from(staffMembers)
        .where(eq(staffMembers.practiceId, practiceId)),
    ),
    patients: await one(
      t.db
        .select({ n: count() })
        .from(patients)
        .where(eq(patients.practiceId, practiceId)),
    ),
    contactPoints: await one(
      t.db
        .select({ n: count() })
        .from(contactPoints)
        .innerJoin(patients, eq(contactPoints.patientId, patients.id))
        .where(eq(patients.practiceId, practiceId)),
    ),
    signals: await one(
      t.db
        .select({ n: count() })
        .from(signals)
        .where(eq(signals.practiceId, practiceId)),
    ),
    derivations: await one(
      t.db
        .select({ n: count() })
        .from(derivations)
        .where(eq(derivations.practiceId, practiceId)),
    ),
    consents: await one(
      t.db
        .select({ n: count() })
        .from(consents)
        .where(eq(consents.practiceId, practiceId)),
    ),
    excerpts: await one(
      t.db
        .select({ n: count() })
        .from(proofExcerpts)
        .where(eq(proofExcerpts.practiceId, practiceId)),
    ),
    responses: await one(
      t.db
        .select({ n: count() })
        .from(responses)
        .where(eq(responses.practiceId, practiceId)),
    ),
    responseTemplates: await one(
      t.db
        .select({ n: count() })
        .from(responseTemplates)
        .where(eq(responseTemplates.practiceId, practiceId)),
    ),
  };
}

describe("runSeed", () => {
  it("seeds the demo practice with the contracted shape, twice (idempotent)", async () => {
    const first = await runSeed(t.db);

    // --- Practice identity matches the design mockup -----------------------
    const [practice] = await t.db
      .select()
      .from(practices)
      .where(eq(practices.clerkOrgId, DEMO_PRACTICE_CLERK_ORG_ID));
    expect(practice?.name).toBe("Cedar Ridge Dental");
    expect(practice?.slug).toBe("cedar-ridge-dental");
    expect(practice?.id).toBe(first.practiceId);

    // --- Counts: fixtures are the contract ---------------------------------
    const counts = await tableCounts(first);
    expect(counts.locations).toBe(LOCATION_FIXTURES.length);
    expect(counts.providers).toBe(PROVIDER_FIXTURES.length);
    expect(counts.staff).toBe(STAFF_FIXTURES.length);
    expect(counts.patients).toBe(PATIENT_FIXTURES.length);
    expect(counts.signals).toBe(SIGNAL_FIXTURES.length);
    expect(counts.signals).toBe(80);
    expect(counts.consents).toBe(EXPECTED_CONSENT_ROWS);
    expect(counts.excerpts).toBe(EXPECTED_EXCERPTS);
    expect(counts.derivations).toBe(first.derivations);
    expect(counts.responses).toBe(REPLIED_FIXTURES.length);
    expect(first.responses).toBe(REPLIED_FIXTURES.length);

    const byKind = await t.db
      .select({ kind: signals.sourceKind, n: count() })
      .from(signals)
      .where(eq(signals.practiceId, first.practiceId))
      .groupBy(signals.sourceKind);
    const byKindMap = Object.fromEntries(byKind.map((r) => [r.kind, r.n]));
    expect(byKindMap).toEqual(EXPECTED_SIGNALS_BY_KIND);

    // --- Deterministic IDs (E2E may select against them) --------------------
    const [g01] = await t.db
      .select()
      .from(signals)
      .where(eq(signals.id, seedId("signal:g01")));
    expect(g01?.originalText).toContain("Dr. Aldana took the time");

    // --- Derivations: every basis represented, seed model version -----------
    const bases = await t.db
      .selectDistinct({ basis: derivations.basis })
      .from(derivations)
      .where(eq(derivations.practiceId, first.practiceId));
    expect(new Set(bases.map((r) => r.basis))).toEqual(
      new Set([
        "source_metadata",
        "manual",
        "inferred_text",
        "inferred_related",
      ]),
    );
    const [manualRow] = await t.db
      .select()
      .from(derivations)
      .where(eq(derivations.basis, "manual"))
      .limit(1);
    expect(manualRow?.modelVersion).toBeNull();
    const [inferredRow] = await t.db
      .select()
      .from(derivations)
      .where(eq(derivations.basis, "inferred_text"))
      .limit(1);
    expect(inferredRow?.modelVersion).toBe("seed-fixture");

    // --- Consents: every state present --------------------------------------
    const sources = await t.db
      .selectDistinct({ source: consents.source })
      .from(consents)
      .where(eq(consents.practiceId, first.practiceId));
    expect(new Set(sources.map((r) => r.source))).toEqual(
      new Set(["patient_link", "practice_attested", "imported_unknown"]),
    );

    const [stateRow] = await t.db
      .select({
        revoked: sql<number>`count(*) filter (where ${consents.revokedAt} is not null)`,
        expired: sql<number>`count(*) filter (where ${consents.expiresAt} < now())`,
        superseded: sql<number>`count(*) filter (where ${consents.consentVersion} >= 2)`,
      })
      .from(consents)
      .where(eq(consents.practiceId, first.practiceId));
    expect(Number(stateRow?.revoked)).toBeGreaterThanOrEqual(1);
    expect(Number(stateRow?.expired)).toBeGreaterThanOrEqual(1);
    expect(Number(stateRow?.superseded)).toBeGreaterThanOrEqual(1);

    // The common case: most signals have NO consent row at all.
    const [noConsent] = await t.db
      .select({ n: count() })
      .from(signals)
      .where(
        sql`${signals.practiceId} = ${first.practiceId} and not exists (
          select 1 from ${consents} where ${consents.signalId} = ${signals.id}
        )`,
      );
    expect(noConsent?.n).toBeGreaterThanOrEqual(60);

    // --- Publication gate honors the seeded states ---------------------------
    const publishable = await isPublishable(
      t.db,
      seedId("signal:fp01"),
      "website",
    );
    expect(publishable.publishable).toBe(true);

    const unconsented = await isPublishable(
      t.db,
      seedId("signal:g04"),
      "website",
    );
    expect(unconsented).toMatchObject({
      publishable: false,
      reason: "no_consent",
    });

    const revoked = await isPublishable(t.db, seedId("signal:fp06"), "website");
    expect(revoked).toMatchObject({ publishable: false, reason: "revoked" });

    const expired = await isPublishable(t.db, seedId("signal:cs03"), "website");
    expect(expired).toMatchObject({ publishable: false, reason: "expired" });

    // Superseded chain: the narrowed v2 wins — gbp was dropped.
    const narrowed = await isPublishable(t.db, seedId("signal:fp02"), "gbp");
    expect(narrowed).toMatchObject({
      publishable: false,
      reason: "channel_not_granted",
    });

    // --- CSV provenance: import run row + id stamped on every csv signal ----
    const csvRows = await t.db
      .select({ importRunId: signals.importRunId })
      .from(signals)
      .where(eq(signals.sourceKind, "csv_import"));
    expect(csvRows).toHaveLength(EXPECTED_SIGNALS_BY_KIND.csv_import ?? 0);
    for (const row of csvRows) {
      expect(row.importRunId).toBe(DEMO_IMPORT_RUN_ID);
    }
    // The run row itself (issue #111): completed, counts matching the CSV
    // fixture corpus, raw artifact key on record.
    const runSummary = await getImportRunSummary(
      t.db,
      first.practiceId,
      DEMO_IMPORT_RUN_ID,
    );
    expect(runSummary).toBeDefined();
    expect(runSummary?.run.status).toBe("completed");
    expect(runSummary?.run.trigger).toBe("manual");
    expect(runSummary?.run.created).toBe(
      EXPECTED_SIGNALS_BY_KIND.csv_import ?? 0,
    );
    expect(runSummary?.errorCount).toBe(0);
    expect(runSummary?.run.rawArtifactKeys).toEqual([DEMO_IMPORT_ARTIFACT_KEY]);
    expect(first.importRuns).toBe(1);

    // --- Starter response templates (issue #83): four, deterministic ids ----
    expect(counts.responseTemplates).toBe(STARTER_RESPONSE_TEMPLATES.length);
    const [positiveTemplate] = await t.db
      .select()
      .from(responseTemplates)
      .where(eq(responseTemplates.id, seedId("template:positive")));
    expect(positiveTemplate?.name).toBe("Positive review");
    expect(positiveTemplate?.tone).toBe("warm");
    expect(positiveTemplate?.active).toBe(true);
    expect(positiveTemplate?.body).toContain("{reviewer_name}");

    // --- Every seeded signal is display-ready (terminal pipeline status) ----
    const [pending] = await t.db
      .select({ n: count() })
      .from(signals)
      .where(
        sql`${signals.practiceId} = ${first.practiceId} and ${signals.pipelineStatus} <> 'processed'`,
      );
    expect(pending?.n).toBe(0);

    // --- Google provenance: real v4 resource names (seed v3, #214) ----------
    const googleRows = await t.db
      .select({ sourceId: signals.sourceId })
      .from(signals)
      .where(
        sql`${signals.practiceId} = ${first.practiceId} and ${signals.sourceKind} = 'google'`,
      );
    for (const row of googleRows) {
      expect(row.sourceId).toMatch(
        /^accounts\/demo\/locations\/[^/]+\/reviews\/g\d+$/,
      );
    }

    // --- Imported owner replies (#214): source_import rows, published -------
    expect(REPLIED_FIXTURES.length).toBeGreaterThan(0);
    const importedResponses = await t.db
      .select()
      .from(responses)
      .where(eq(responses.practiceId, first.practiceId));
    expect(importedResponses).toHaveLength(REPLIED_FIXTURES.length);
    for (const fixture of REPLIED_FIXTURES) {
      const row = importedResponses.find(
        (r) => r.signalId === seedId(`signal:${fixture.key}`),
      );
      expect(row).toMatchObject({
        origin: "source_import",
        status: "published",
        authorId: null,
        body: fixture.existingReply?.comment,
        moderationState: fixture.existingReply?.state,
      });
      expect(row?.publishedAt).not.toBeNull();
      expect(row?.publishUpdateTime).toBe(row?.publishedAt?.toISOString());
      // The fixture's review name is the row's signal — and matches the
      // demo artifact builder byte-for-byte.
      const [parent] = await t.db
        .select({ sourceId: signals.sourceId })
        .from(signals)
        .where(eq(signals.id, row?.signalId ?? ""));
      expect(parent?.sourceId).toBe(demoGoogleReviewName(fixture));
    }

    // --- Proof excerpts: embeddings left NULL (Epic #9 backfills) -----------
    const [nullEmbeddings] = await t.db
      .select({ n: count() })
      .from(proofExcerpts)
      .where(isNull(proofExcerpts.embedding));
    expect(nullEmbeddings?.n).toBe(EXPECTED_EXCERPTS);

    // --- Encrypted contact round-trip via the dev keyring --------------------
    const keyring = devKeyring();
    const raw = "jordan.mercado@example.com";
    const contact = await findContactPoint(
      t.db,
      first.practiceId,
      "email",
      raw,
      keyring,
    );
    expect(contact).toBeDefined();
    if (!contact) throw new Error("unreachable");
    expect(contact.valueEncrypted).not.toContain(raw);
    expect(contact.valueHash).toBe(await hashField(raw, keyring));
    await expect(decryptField(contact.valueEncrypted, keyring)).resolves.toBe(
      raw,
    );

    // An opted-out contact point exists (suppression checks, Epic #19).
    const [optedOut] = await t.db
      .select({ n: count() })
      .from(contactPoints)
      .where(
        sql`${contactPoints.optedOutAt} is not null and ${contactPoints.patientId} = ${seedId("patient:marcus")}`,
      );
    expect(optedOut?.n).toBe(1);

    // --- Idempotency: run again, identical shape, same stable ids -----------
    const firstSignalIds = (
      await t.db.select({ id: signals.id }).from(signals)
    ).map((r) => r.id);

    const second = await runSeed(t.db);
    expect(second).toEqual(first);

    const countsAfter = await tableCounts(second);
    expect(countsAfter).toEqual(counts);

    const secondSignalIds = (
      await t.db.select({ id: signals.id }).from(signals)
    ).map((r) => r.id);
    expect(new Set(secondSignalIds)).toEqual(new Set(firstSignalIds));

    // Only one demo practice ever exists.
    const [practiceCount] = await t.db
      .select({ n: count() })
      .from(practices)
      .where(eq(practices.clerkOrgId, DEMO_PRACTICE_CLERK_ORG_ID));
    expect(practiceCount?.n).toBe(1);
  });
});
