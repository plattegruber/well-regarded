/**
 * Manual signal entry (issue #138, Epic #8), mounted under the staff-auth
 * group at /api/signals — the submission endpoint behind the dashboard's
 * "Add signal" form.
 *
 * THE STRUCTURAL RULE: the submission goes through the standard pipeline
 * via the `manual` SourceAdapter — the validated form payload becomes a
 * raw artifact and one `IngestMessage` — NEVER a direct `signals` insert.
 * The round-trip costs milliseconds and buys uniformity: classification,
 * dedupe, routing, consent handling, and provenance apply to a typed-in
 * compliment exactly as they do to an imported review (a furious
 * phone-call transcript must route to recovery like a 1-star review
 * would).
 *
 * Ordering contract (issues #100/#111):
 *   1. store the artifact in R2 (store-before-enqueue; content-addressed,
 *      so a retried submission of identical content re-writes nothing);
 *   2. create the one-row `import_runs` record (trigger `manual`) with the
 *      artifact key already on it — dedupe's conflict path re-reads the
 *      run's keys — and audit `signal.manual_created` in the same
 *      transaction;
 *   3. enqueue the `IngestMessage`.
 * A crash between 2 and 3 leaves a `running` run with a durable artifact —
 * visible, replayable, never a half-written signal.
 *
 * Permission: any staff role that can view private feedback can add one
 * (manual entries ARE private feedback; matrix: everyone but
 * external_partner, location-scoped roles within their scope). The
 * ATTESTATION choice alone is additionally gated on `manage_consent` —
 * recording "the practice attests the patient said yes" is a consent
 * write, and roles without that permission (marketing) submit with
 * consent "unknown" instead.
 */

import {
  can,
  manualSignalFormSchema,
  type StaffActor,
} from "@wellregarded/core";
import { audit, createImportRun, schema } from "@wellregarded/db";
import {
  buildManualEntryArtifact,
  type ManualEntryBody,
  putRawArtifact,
} from "@wellregarded/sources";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

import type { AppEnv } from "../bindings";

const { locations, providers } = schema;

export const signalRoutes = new Hono<AppEnv>();

signalRoutes.post("/manual", async (c) => {
  const actor: StaffActor = c.get("actor");
  const db = c.get("db");

  const parsed = manualSignalFormSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json(
      {
        error: "invalid_entry" as const,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      400,
    );
  }
  const form = parsed.data;

  // Location/provider are structured choices — validate they belong to
  // this practice and resolve their NAMES: the artifact carries hint text
  // (basis "manual"), and the normalize stage resolves it back to FKs like
  // every other source.
  let locationName: string | undefined;
  if (form.locationId !== undefined) {
    const [row] = await db
      .select({ name: locations.name })
      .from(locations)
      .where(
        and(
          eq(locations.id, form.locationId),
          eq(locations.practiceId, actor.practiceId),
        ),
      )
      .limit(1);
    if (!row) return c.json({ error: "unknown_location" as const }, 422);
    locationName = row.name;
  }
  let providerName: string | undefined;
  if (form.providerId !== undefined) {
    const [row] = await db
      .select({ name: providers.displayName })
      .from(providers)
      .where(
        and(
          eq(providers.id, form.providerId),
          eq(providers.practiceId, actor.practiceId),
        ),
      )
      .limit(1);
    if (!row) return c.json({ error: "unknown_provider" as const }, 422);
    providerName = row.name;
  }

  // Location-scoped where the entry names a location; practice-wide
  // otherwise (can()'s scoped semantics).
  const resource = {
    practiceId: actor.practiceId,
    locationId: form.locationId ?? null,
  };
  if (!can(actor, "view_private_feedback", resource)) {
    return c.json({ error: "forbidden" as const, reason: "permission" }, 403);
  }
  if (
    form.consent.choice === "practice_attested" &&
    !can(actor, "manage_consent", resource)
  ) {
    // Gate only the attestation, not the form (issue #138 requirement 6).
    return c.json(
      {
        error: "attestation_forbidden" as const,
        message:
          "Your role can't record consent on the patient's behalf. Save it without permission documented, or ask an office manager.",
      },
      403,
    );
  }

  const enteredAt = new Date().toISOString();
  const sourceId = crypto.randomUUID();
  const entry: ManualEntryBody = {
    text: form.text,
    // The form captures a calendar date; the experience time is midnight
    // UTC of that date — honest precision, not fake timestamps.
    occurredAt: `${form.occurredOn}T00:00:00Z`,
    sourceDescription: form.sourceDescription,
    ...(locationName !== undefined ? { locationName } : {}),
    ...(providerName !== undefined ? { providerName } : {}),
    ...(form.patient !== undefined ? { patient: form.patient } : {}),
    consent: form.consent,
  };
  const artifact = buildManualEntryArtifact({
    practiceId: actor.practiceId,
    sourceId,
    enteredBy: actor.staffId,
    enteredAt,
    entry,
  });

  // 1. Store-before-everything: the artifact is the durable submission.
  const { key } = await putRawArtifact(c.env.RAW_ARTIFACTS, {
    practiceId: actor.practiceId,
    sourceKind: "manual",
    content: JSON.stringify(artifact),
  });

  // 2. One-row run + audit, atomically; the key is on the run BEFORE any
  //    message references it (#111 contract).
  const run = await db.transaction(async (tx) => {
    const created = await createImportRun(tx, {
      practiceId: actor.practiceId,
      sourceKind: "manual",
      trigger: "manual",
      rawArtifactKeys: [key],
    });
    await audit(tx, {
      practiceId: actor.practiceId,
      actor: { type: "staff", id: actor.staffId },
      action: "signal.manual_created",
      entityType: "import_runs",
      entityId: created.id,
      payload: {
        sourceId,
        rawArtifactKey: key,
        sourceDescription: form.sourceDescription,
        consentChoice: form.consent.choice,
        hasPatient: form.patient !== undefined,
        requestId: c.get("requestId"),
      },
    });
    return created;
  });

  // 3. Enqueue — the pipeline takes it from here (classification is
  //    async; the form says so instead of faking instant availability).
  await c.env.INGEST_QUEUE.send({
    importRunId: run.id,
    rawArtifactKey: key,
    sourceKind: "manual",
    practiceId: actor.practiceId,
    requestId: c.get("requestId"),
  });

  return c.json({ importRunId: run.id, signalPending: true as const }, 201);
});
