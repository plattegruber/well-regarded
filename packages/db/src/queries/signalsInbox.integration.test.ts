/**
 * Integration coverage for the signals inbox reads (issues #88/#90):
 * `listSignals` filters/FTS/pagination/permissions against the seeded demo
 * corpus (the fixture arrays are the expectation source, as in
 * `../seed/seed.integration.test.ts`), `getSignalDetail` assembly and its
 * identity audit, and `resolveSuspectedDuplicate`'s write + audit.
 */

import { type Actor, describeConsentState } from "@wellregarded/core";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  derivation as derivationFactory,
  practice as practiceFactory,
  signal as signalFactory,
} from "../../test/factories.js";
import { setupTestDb } from "../../test/harness.js";
import { auditLog } from "../schema/audit.js";
import { suspectedDuplicates } from "../schema/dedupe.js";
import { signals } from "../schema/signals.js";
import {
  LOCATION_FIXTURES,
  PATIENT_FIXTURES,
} from "../seed/fixtures/demoPractice.js";
import { SIGNAL_FIXTURES } from "../seed/fixtures/signals.js";
import { seedId } from "../seed/ids.js";
import { DEMO_PRACTICE_ID, runSeed } from "../seed/run.js";
import { canonicalPair, resolveSuspectedDuplicate } from "./dedupe.js";
import {
  decodeSignalsCursor,
  getSignalDetail,
  listSignals,
  type SignalListItem,
} from "./signalsInbox.js";

const t = setupTestDb();

beforeAll(async () => {
  await runSeed(t.db);
});

const FULL = { viewPrivateFeedback: true, viewPatientIdentity: true };
const NO_IDENTITY = { viewPrivateFeedback: true, viewPatientIdentity: false };
const PUBLIC_ONLY = { viewPrivateFeedback: false, viewPatientIdentity: false };
const ACTOR: Actor = { type: "staff", id: seedId("staff:owner_aldana") };

const signalId = (key: string) => seedId(`signal:${key}`);

/** Fixture-derived expectations — the fixture array is the contract. */
const effectiveSentiment = (fixture: (typeof SIGNAL_FIXTURES)[number]) =>
  fixture.manualSentiment ?? fixture.sentiment;
const countWhere = (
  predicate: (fixture: (typeof SIGNAL_FIXTURES)[number]) => boolean,
) => SIGNAL_FIXTURES.filter(predicate).length;

async function collectAllPages(
  params: Parameters<typeof listSignals>[1],
): Promise<SignalListItem[]> {
  const items: SignalListItem[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const result = await listSignals(t.db, { ...params, cursor });
    items.push(...result.items);
    cursor = result.nextCursor;
    if (cursor === null) return items;
  }
  throw new Error("pagination did not terminate");
}

describe("listSignals — pagination", () => {
  it("returns 25 newest-first by default, with a cursor", async () => {
    const page = await listSignals(t.db, {
      practiceId: DEMO_PRACTICE_ID,
      viewer: FULL,
    });
    expect(page.items).toHaveLength(25);
    expect(page.nextCursor).not.toBeNull();
    const times = page.items.map((item) => item.occurredAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("walks every seeded signal exactly once, in one stable order", async () => {
    const paged = await collectAllPages({
      practiceId: DEMO_PRACTICE_ID,
      viewer: FULL,
    });
    expect(paged).toHaveLength(SIGNAL_FIXTURES.length);
    expect(new Set(paged.map((item) => item.id)).size).toBe(paged.length);

    const oneShot = await listSignals(t.db, {
      practiceId: DEMO_PRACTICE_ID,
      viewer: FULL,
      limit: SIGNAL_FIXTURES.length + 10,
    });
    expect(paged.map((item) => item.id)).toEqual(
      oneShot.items.map((item) => item.id),
    );
    expect(oneShot.nextCursor).toBeNull();
  });

  it("treats a malformed cursor as page one", async () => {
    expect(decodeSignalsCursor("not-a-cursor")).toBeNull();
    const page = await listSignals(t.db, {
      practiceId: DEMO_PRACTICE_ID,
      viewer: FULL,
      cursor: "not-a-cursor",
    });
    expect(page.items).toHaveLength(25);
  });

  it("is practice-scoped: another practice sees nothing", async () => {
    const other = await practiceFactory(t.db);
    const page = await listSignals(t.db, {
      practiceId: other.id,
      viewer: FULL,
    });
    expect(page.items).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
  });
});

describe("listSignals — filters", () => {
  const list = (
    filters: NonNullable<Parameters<typeof listSignals>[1]["filters"]>,
  ) => collectAllPages({ practiceId: DEMO_PRACTICE_ID, viewer: FULL, filters });

  it("source_kind", async () => {
    const items = await list({ sourceKind: "google" });
    expect(items).toHaveLength(countWhere((f) => f.sourceKind === "google"));
    expect(items.every((item) => item.sourceKind === "google")).toBe(true);
  });

  it("visibility", async () => {
    const items = await list({ visibility: "private" });
    expect(items).toHaveLength(countWhere((f) => f.visibility === "private"));
  });

  it("sentiment respects the current derivation — manual outranks inferred", async () => {
    const items = await list({ sentiment: "mixed" });
    expect(items).toHaveLength(
      countWhere((f) => effectiveSentiment(f) === "mixed"),
    );
    // cs10's model said negative; a human corrected to mixed. The manual
    // row must win, and the row must say so.
    const cs10 = items.find((item) => item.id === signalId("cs10"));
    expect(cs10?.sentiment).toMatchObject({ value: "mixed", basis: "manual" });
  });

  it("urgency", async () => {
    const items = await list({ urgency: "high" });
    expect(items).toHaveLength(countWhere((f) => f.urgency === "high"));
  });

  it("location and provider", async () => {
    const north = LOCATION_FIXTURES.find((f) => f.key === "north");
    expect(north).toBeDefined();
    const atNorth = await list({ locationId: seedId("location:north") });
    expect(atNorth).toHaveLength(countWhere((f) => f.location === "north"));
    expect(atNorth.every((item) => item.locationName === north?.name)).toBe(
      true,
    );

    const patel = await list({ providerId: seedId("provider:patel") });
    expect(patel).toHaveLength(countWhere((f) => f.provider === "patel"));
    expect(patel.every((item) => item.providerName === "Dr. Patel")).toBe(true);
  });

  it("filters compose with AND", async () => {
    const items = await list({ sourceKind: "google", sentiment: "negative" });
    expect(items).toHaveLength(
      countWhere(
        (f) =>
          f.sourceKind === "google" && effectiveSentiment(f) === "negative",
      ),
    );
  });

  it("unclassified matches signals with no derivation for the dimension", async () => {
    const practice = await practiceFactory(t.db);
    const judged = await signalFactory(t.db, { practiceId: practice.id });
    await derivationFactory(t.db, {
      signalId: judged.id,
      dimension: "sentiment",
      value: "positive",
    });
    const bare = await signalFactory(t.db, { practiceId: practice.id });

    const page = await listSignals(t.db, {
      practiceId: practice.id,
      viewer: FULL,
      filters: { sentiment: "unclassified" },
    });
    expect(page.items.map((item) => item.id)).toEqual([bare.id]);
    expect(page.items[0]?.sentiment).toBeNull();
  });
});

describe("listSignals — full-text search", () => {
  it("finds the billing complaints by word", async () => {
    const items = await collectAllPages({
      practiceId: DEMO_PRACTICE_ID,
      viewer: FULL,
      filters: { q: "billing" },
    });
    const ids = items.map((item) => item.id);
    expect(ids).toContain(signalId("g43"));
    expect(ids).toContain(signalId("cs10"));
    expect(items.every((item) => /bill/i.test(item.text ?? ""))).toBe(true);
  });

  it("supports quoted phrases", async () => {
    const page = await listSignals(t.db, {
      practiceId: DEMO_PRACTICE_ID,
      viewer: FULL,
      filters: { q: '"covering my mouth"' },
    });
    expect(page.items.map((item) => item.id)).toEqual([signalId("cs03")]);
  });

  it("search composes with filters (AND)", async () => {
    const items = await collectAllPages({
      practiceId: DEMO_PRACTICE_ID,
      viewer: FULL,
      filters: { q: "billing", visibility: "private" },
    });
    // The public billing reviews (g43 and friends) are filtered out; only
    // private matches — the CSV complaint among them — remain.
    expect(items.map((item) => item.id)).toContain(signalId("cs10"));
    expect(items.map((item) => item.id)).not.toContain(signalId("g43"));
    expect(items.every((item) => item.visibility === "private")).toBe(true);
    expect(items.every((item) => /bill/i.test(item.text ?? ""))).toBe(true);
  });

  it("orders by ts_rank desc, then recency, and paginates stably", async () => {
    const practice = await practiceFactory(t.db);
    const once = await signalFactory(t.db, {
      practiceId: practice.id,
      occurredAt: new Date("2026-01-02T00:00:00Z"),
      originalText: "The parking was easy to find.",
    });
    const thrice = await signalFactory(t.db, {
      practiceId: practice.id,
      occurredAt: new Date("2026-01-01T00:00:00Z"),
      originalText:
        "Parking, parking, parking — the parking garage is next door.",
    });

    const ranked = await listSignals(t.db, {
      practiceId: practice.id,
      viewer: FULL,
      filters: { q: "parking" },
    });
    // Higher rank first despite being older.
    expect(ranked.items.map((item) => item.id)).toEqual([thrice.id, once.id]);

    const pageOne = await listSignals(t.db, {
      practiceId: practice.id,
      viewer: FULL,
      filters: { q: "parking" },
      limit: 1,
    });
    expect(pageOne.items.map((item) => item.id)).toEqual([thrice.id]);
    expect(pageOne.nextCursor).not.toBeNull();
    const pageTwo = await listSignals(t.db, {
      practiceId: practice.id,
      viewer: FULL,
      filters: { q: "parking" },
      limit: 1,
      cursor: pageOne.nextCursor,
    });
    expect(pageTwo.items.map((item) => item.id)).toEqual([once.id]);
    expect(pageTwo.nextCursor).toBeNull();
  });
});

describe("listSignals — permissions", () => {
  it("never returns a patient name without view_patient_identity", async () => {
    const items = await collectAllPages({
      practiceId: DEMO_PRACTICE_ID,
      viewer: NO_IDENTITY,
    });
    const withPatient = items.filter((item) => item.patient !== null);
    expect(withPatient.length).toBeGreaterThan(0);
    for (const item of withPatient) {
      expect(item.patient).toEqual({ displayName: null, redacted: true });
    }
    // The name is absent from the returned rows, not just hidden by a UI.
    const serialized = JSON.stringify(items);
    for (const patient of PATIENT_FIXTURES) {
      expect(serialized).not.toContain(patient.displayName);
    }
  });

  it("returns patient names with the permission", async () => {
    const items = await collectAllPages({
      practiceId: DEMO_PRACTICE_ID,
      viewer: FULL,
    });
    const ruth = items.find((item) => item.id === signalId("cs03"));
    expect(ruth?.patient).toEqual({
      displayName: "Ruth Adler",
      redacted: false,
    });
  });

  it("forces public-only without view_private_feedback", async () => {
    const items = await collectAllPages({
      practiceId: DEMO_PRACTICE_ID,
      viewer: PUBLIC_ONLY,
    });
    expect(items).toHaveLength(countWhere((f) => f.visibility === "public"));
    expect(items.every((item) => item.visibility === "public")).toBe(true);

    // Asking for private anyway yields nothing — least privilege wins.
    const page = await listSignals(t.db, {
      practiceId: DEMO_PRACTICE_ID,
      viewer: PUBLIC_ONLY,
      filters: { visibility: "private" },
    });
    expect(page.items).toHaveLength(0);
  });
});

describe("listSignals — consent on rows", () => {
  it("carries the winning consent row; describeConsentState interprets it", async () => {
    const items = await collectAllPages({
      practiceId: DEMO_PRACTICE_ID,
      viewer: FULL,
    });
    const byId = new Map(items.map((item) => [item.id, item]));

    // cs02: practice-attested website + in-office grant → publishable.
    const granted = byId.get(signalId("cs02"));
    expect(granted?.consent?.channels).toEqual(["website", "in_office"]);
    const grantedState = describeConsentState(
      granted?.consent ? [granted.consent] : [],
      new Date(),
    );
    expect(grantedState.publishable).toBe(true);

    // cs03: the grant expired → not publishable, with the reason.
    const expired = byId.get(signalId("cs03"));
    expect(expired?.consent).not.toBeNull();
    const expiredState = describeConsentState(
      expired?.consent ? [expired.consent] : [],
      new Date(),
    );
    expect(expiredState).toMatchObject({
      publishable: false,
      status: "expired",
    });

    // mn01: no consent recorded — the honest default.
    const none = byId.get(signalId("mn01"));
    expect(none?.consent).toBeNull();
    expect(describeConsentState([], new Date()).summary).toBe(
      "No consent recorded — not publishable",
    );
  });
});

describe("suspected duplicates — list flag, filter, detail, resolve", () => {
  it("flags and filters pending links; detail shows the counterpart; resolution writes + audits", async () => {
    const pair = canonicalPair(signalId("g04"), signalId("em03"));
    const [link] = await t.db
      .insert(suspectedDuplicates)
      .values({ practiceId: DEMO_PRACTICE_ID, ...pair, similarity: 0.95 })
      .returning();
    if (!link) throw new Error("suspected duplicate insert returned no row");

    // Filter: exactly the two linked signals.
    const flagged = await collectAllPages({
      practiceId: DEMO_PRACTICE_ID,
      viewer: FULL,
      filters: { suspectedDuplicate: true },
    });
    expect(flagged.map((item) => item.id).sort()).toEqual(
      [signalId("g04"), signalId("em03")].sort(),
    );
    expect(flagged.every((item) => item.suspectedDuplicate)).toBe(true);

    // Detail: the counterpart preview rides along.
    const detail = await getSignalDetail(t.db, {
      practiceId: DEMO_PRACTICE_ID,
      signalId: signalId("g04"),
      viewer: FULL,
      actor: ACTOR,
    });
    expect(detail?.duplicates).toHaveLength(1);
    expect(detail?.duplicates[0]?.link.id).toBe(link.id);
    expect(detail?.duplicates[0]?.other.id).toBe(signalId("em03"));
    expect(detail?.duplicates[0]?.other.text).toContain("insurance adjustment");

    // Resolve "different" → dismissed + audited, atomically.
    const resolved = await resolveSuspectedDuplicate(t.db, {
      practiceId: DEMO_PRACTICE_ID,
      duplicateId: link.id,
      resolution: "different",
      actor: ACTOR,
    });
    expect(resolved?.status).toBe("dismissed");
    const [dismissAudit] = await t.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "suspected_duplicate.dismissed"),
          eq(auditLog.entityId, link.id),
        ),
      );
    expect(dismissAudit).toMatchObject({
      practiceId: DEMO_PRACTICE_ID,
      actorType: "staff",
      actorId: ACTOR.type === "staff" ? ACTOR.id : "",
      entityType: "suspected_duplicates",
      payload: {
        resolution: "different",
        signalIdA: pair.signalIdA,
        signalIdB: pair.signalIdB,
      },
    });

    // A resolved link no longer flags its signals…
    const afterResolve = await listSignals(t.db, {
      practiceId: DEMO_PRACTICE_ID,
      viewer: FULL,
      filters: { suspectedDuplicate: true },
    });
    expect(afterResolve.items).toHaveLength(0);

    // …and cannot be resolved twice.
    const again = await resolveSuspectedDuplicate(t.db, {
      practiceId: DEMO_PRACTICE_ID,
      duplicateId: link.id,
      resolution: "same",
      actor: ACTOR,
    });
    expect(again).toBeUndefined();
  });

  it("resolves 'same' to confirmed + audit; cross-practice ids do nothing", async () => {
    const pair = canonicalPair(signalId("g06"), signalId("g07"));
    const [link] = await t.db
      .insert(suspectedDuplicates)
      .values({ practiceId: DEMO_PRACTICE_ID, ...pair, similarity: 0.93 })
      .returning();
    if (!link) throw new Error("suspected duplicate insert returned no row");

    // A different practice cannot resolve this practice's link.
    const other = await practiceFactory(t.db);
    const denied = await resolveSuspectedDuplicate(t.db, {
      practiceId: other.id,
      duplicateId: link.id,
      resolution: "same",
      actor: ACTOR,
    });
    expect(denied).toBeUndefined();

    const resolved = await resolveSuspectedDuplicate(t.db, {
      practiceId: DEMO_PRACTICE_ID,
      duplicateId: link.id,
      resolution: "same",
      actor: ACTOR,
    });
    expect(resolved?.status).toBe("confirmed");
    const [confirmAudit] = await t.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "suspected_duplicate.confirmed"),
          eq(auditLog.entityId, link.id),
        ),
      );
    expect(confirmAudit).toMatchObject({
      payload: { resolution: "same" },
    });
  });
});

describe("getSignalDetail", () => {
  it("assembles a fully-loaded seeded signal", async () => {
    const detail = await getSignalDetail(t.db, {
      practiceId: DEMO_PRACTICE_ID,
      signalId: signalId("cs02"),
      viewer: FULL,
      actor: ACTOR,
    });
    expect(detail).toBeDefined();
    expect(detail?.currentText).toContain("recommended Dr. Patel");
    expect(detail?.providerName).toBe("Dr. Patel");
    expect(detail?.signal.sourceKind).toBe("csv_import");
    expect(detail?.excerpts).toHaveLength(1);
    expect(detail?.excerpts[0]?.topics).toContain("implants");
    expect(detail?.consents).toHaveLength(1);
    expect(detail?.currentDerivations.sentiment).toMatchObject({
      value: "positive",
    });
    expect(detail?.currentDerivations.response_risk).toBeUndefined();
    // The legacy CSV import run rides along, with its artifact keys.
    expect(detail?.importRun?.run.sourceKind).toBe("csv_import");
    expect(detail?.importRun?.run.rawArtifactKeys.length).toBeGreaterThan(0);
  });

  it("assembles a minimal manual note without invented sections", async () => {
    const detail = await getSignalDetail(t.db, {
      practiceId: DEMO_PRACTICE_ID,
      signalId: signalId("mn01"),
      viewer: FULL,
      actor: ACTOR,
    });
    expect(detail?.signal.sourceId).toBeNull();
    expect(detail?.signal.sourceUrl).toBeNull();
    expect(detail?.importRun).toBeUndefined();
    expect(detail?.excerpts).toHaveLength(0);
    expect(detail?.consents).toHaveLength(0);
    expect(detail?.versions).toHaveLength(0);
    expect(detail?.patient).toBeNull();
  });

  it("includes identity with the permission — and audits the access", async () => {
    const before = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "patient.viewed"));

    const detail = await getSignalDetail(t.db, {
      practiceId: DEMO_PRACTICE_ID,
      signalId: signalId("cs03"),
      viewer: FULL,
      actor: ACTOR,
    });
    expect(detail?.patient).toEqual({
      displayName: "Ruth Adler",
      redacted: false,
    });

    const after = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "patient.viewed"));
    expect(after).toHaveLength(before.length + 1);
    expect(after[after.length - 1]).toMatchObject({
      entityType: "patients",
      entityId: seedId("patient:ruth"),
      payload: { signalId: signalId("cs03"), surface: "signal_detail" },
    });
  });

  it("redacts identity without the permission — and does not audit", async () => {
    const before = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "patient.viewed"));

    const detail = await getSignalDetail(t.db, {
      practiceId: DEMO_PRACTICE_ID,
      signalId: signalId("cs03"),
      viewer: NO_IDENTITY,
      actor: ACTOR,
    });
    expect(detail?.patient).toEqual({ displayName: null, redacted: true });
    expect(JSON.stringify(detail)).not.toContain("Ruth Adler");

    const after = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "patient.viewed"));
    expect(after).toHaveLength(before.length);
  });

  it("reads as absent for a private signal without view_private_feedback", async () => {
    const detail = await getSignalDetail(t.db, {
      practiceId: DEMO_PRACTICE_ID,
      signalId: signalId("mn01"),
      viewer: PUBLIC_ONLY,
      actor: ACTOR,
    });
    expect(detail).toBeUndefined();
  });

  it("reads as absent across practices", async () => {
    const other = await practiceFactory(t.db);
    const detail = await getSignalDetail(t.db, {
      practiceId: other.id,
      signalId: signalId("g01"),
      viewer: FULL,
      actor: ACTOR,
    });
    expect(detail).toBeUndefined();
  });
});

describe("signals.tsv (migration 0016)", () => {
  it("populates the stored generated column on insert", async () => {
    const row = await signalFactory(t.db, {
      originalText: "The sedation options made the whole visit calm.",
    });
    const [selected] = await t.db
      .select({ tsv: sql<string>`${signals.tsv}::text` })
      .from(signals)
      .where(eq(signals.id, row.id));
    expect(selected?.tsv).toContain("sedat");
  });

  it("backfills existing rows when the column is added (STORED semantics)", async () => {
    // The migration adds the column to a table that already has rows;
    // reproduce that shape on a scratch table to verify the backfill.
    await t.sql.unsafe(`CREATE TABLE tsv_backfill_probe (body text)`);
    await t.sql.unsafe(
      `INSERT INTO tsv_backfill_probe VALUES ('billing question'), (NULL)`,
    );
    await t.sql.unsafe(
      `ALTER TABLE tsv_backfill_probe ADD COLUMN tsv tsvector
         GENERATED ALWAYS AS (to_tsvector('english', coalesce(body, ''))) STORED`,
    );
    const rows = await t.sql.unsafe(
      `SELECT tsv::text AS tsv FROM tsv_backfill_probe ORDER BY body NULLS LAST`,
    );
    expect(rows[0]?.tsv).toContain("bill");
    expect(rows[1]?.tsv).toBe("");
  });

  it("has the GIN index", async () => {
    const rows = await t.sql.unsafe(
      `SELECT indexdef FROM pg_indexes
       WHERE tablename = 'signals' AND indexname = 'signals_tsv_gin_idx'`,
    );
    expect(rows[0]?.indexdef).toContain("USING gin");
  });
});
