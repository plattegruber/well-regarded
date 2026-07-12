/**
 * Manual entry endpoint (issue #138): the submission round-trip through
 * `app.request()` against real Postgres — artifact durable in the R2 fake,
 * one-row `manual` import run created with the key recorded, the
 * `IngestMessage` enqueued with exactly the shape the pipeline's ingest
 * schema accepts, audit written — plus the permission gates (form vs
 * attestation) and validation failures.
 */

import { ingestMessageSchema, resetEnvCache } from "@wellregarded/core";
import { schema } from "@wellregarded/db";
import { manualEntryArtifactSchema } from "@wellregarded/sources";
import { InMemoryRawArtifactBucket } from "@wellregarded/sources/testing";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  location,
  practice,
  provider,
  staffMember,
} from "../../../packages/db/test/factories.js";
import { setupTestDb } from "../../../packages/db/test/harness.js";
import {
  requireDatabaseUrl,
  withDatabase,
} from "../../../packages/db/test/support.js";
import { app } from "../src/app";
import { testEnv } from "./support/env";
import {
  generateTestKeys,
  signSessionToken,
  type TestKeys,
} from "./support/jwt";

const { auditLog, importRuns } = schema;

const t = setupTestDb();

let keys: TestKeys;

beforeAll(async () => {
  keys = await generateTestKeys();
});

beforeEach(() => {
  resetEnvCache();
});

interface RecordingQueue {
  sent: unknown[];
  send(body: unknown): Promise<void>;
}

function recordingQueue(): RecordingQueue {
  const sent: unknown[] = [];
  return {
    sent,
    send: async (body: unknown) => {
      sent.push(body);
    },
  };
}

function env(bucket: InMemoryRawArtifactBucket, ingest: RecordingQueue) {
  return testEnv({
    HYPERDRIVE: {
      connectionString: withDatabase(requireDatabaseUrl(), t.databaseName),
    },
    CLERK_JWKS_PUBLIC_KEY: keys.publicKeyPem,
    RAW_ARTIFACTS: bucket,
    INGEST_QUEUE: ingest,
  });
}

type StaffRole =
  | "owner"
  | "office_manager"
  | "front_desk"
  | "marketing"
  | "external_partner";

/** A practice plus an authenticated staff member of the given role. */
async function staffCaller(role: StaffRole = "owner") {
  const n = `${role}_${Math.random().toString(36).slice(2, 10)}`;
  const p = await practice(t.db);
  const staff = await staffMember(t.db, {
    practiceId: p.id,
    clerkUserId: `user_${n}`,
    role,
  });
  const token = await signSessionToken(keys, {
    sub: staff.clerkUserId,
    claims: { o: { id: p.clerkOrgId, rol: "member" } },
  });
  return { practice: p, staff, token };
}

const MINIMAL_BODY = {
  text: "Front desk fit me in the same day for a broken crown.",
  occurredOn: "2026-07-01",
  sourceDescription: "in person",
  consent: { choice: "unknown" },
};

async function postManual(token: string, body: unknown, e: object) {
  return app.request(
    "http://localhost/api/signals/manual",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    e,
  );
}

describe("POST /api/signals/manual (issue #138)", () => {
  it("happy path: artifact in R2, run row with key, ingest message shaped for the pipeline, audit entry", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const ingest = recordingQueue();
    const caller = await staffCaller("owner");
    const loc = await location(t.db, {
      practiceId: caller.practice.id,
      name: "Main Street office",
    });
    const prov = await provider(t.db, {
      practiceId: caller.practice.id,
      displayName: "Dr. Patel",
    });

    const response = await postManual(
      caller.token,
      {
        ...MINIMAL_BODY,
        locationId: loc.id,
        providerId: prov.id,
        patient: { name: "Rosa Alvarez", email: "rosa@example.com" },
        consent: {
          choice: "practice_attested",
          channels: ["website"],
          note: "Said yes over the phone, 3/2, spoke with Dana.",
        },
      },
      env(bucket, ingest),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      importRunId: string;
      signalPending: boolean;
    };
    expect(body.signalPending).toBe(true);

    // The one-row run exists, trigger manual, with the artifact key
    // recorded BEFORE the message referenced it.
    const [run] = await t.db
      .select()
      .from(importRuns)
      .where(eq(importRuns.id, body.importRunId));
    expect(run).toMatchObject({
      practiceId: caller.practice.id,
      sourceKind: "manual",
      trigger: "manual",
      status: "running",
    });
    expect(run?.rawArtifactKeys).toHaveLength(1);
    const key = run?.rawArtifactKeys[0] as string;

    // The artifact is durable in R2 and parses as the manual envelope —
    // names resolved from the structured choices, consent verbatim.
    const stored = await bucket.get(key);
    expect(stored).not.toBeNull();
    const artifact = manualEntryArtifactSchema.parse(
      JSON.parse(await (stored as { text(): Promise<string> }).text()),
    );
    expect(artifact.enteredBy).toBe(caller.staff.id);
    expect(artifact.entry).toMatchObject({
      text: MINIMAL_BODY.text,
      occurredAt: "2026-07-01T00:00:00Z",
      sourceDescription: "in person",
      locationName: "Main Street office",
      providerName: "Dr. Patel",
      patient: { name: "Rosa Alvarez", email: "rosa@example.com" },
      consent: { choice: "practice_attested", channels: ["website"] },
    });

    // Exactly one ingest message, and it passes the pipeline's own wire
    // schema — the strongest "standard pipeline" assertion an API test
    // can make (the full run is workers/pipeline's manualEntry suite).
    expect(ingest.sent).toHaveLength(1);
    const message = ingestMessageSchema.parse(ingest.sent[0]);
    expect(message).toMatchObject({
      importRunId: body.importRunId,
      rawArtifactKey: key,
      sourceKind: "manual",
      practiceId: caller.practice.id,
    });
    expect(message.requestId).toBeTruthy();

    // Audited, actor = the staff member (issue #138 requirement 5).
    const audits = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.practiceId, caller.practice.id));
    const entry = audits.find((a) => a.action === "signal.manual_created");
    expect(entry).toMatchObject({
      actorType: "staff",
      actorId: caller.staff.id,
      entityType: "import_runs",
      entityId: body.importRunId,
    });
    expect(entry?.payload).toMatchObject({
      consentChoice: "practice_attested",
      hasPatient: true,
    });
  });

  it("rejects invalid payloads (missing text, future date) without side effects", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const ingest = recordingQueue();
    const caller = await staffCaller("owner");

    for (const bad of [
      { ...MINIMAL_BODY, text: "   " },
      { ...MINIMAL_BODY, occurredOn: "2999-01-01" },
      { ...MINIMAL_BODY, consent: { choice: "practice_attested" } },
    ]) {
      const response = await postManual(caller.token, bad, env(bucket, ingest));
      expect(response.status).toBe(400);
    }
    expect(ingest.sent).toHaveLength(0);
    const runs = await t.db
      .select()
      .from(importRuns)
      .where(eq(importRuns.practiceId, caller.practice.id));
    expect(runs).toHaveLength(0);
  });

  it("rejects a location/provider belonging to another practice", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const ingest = recordingQueue();
    const caller = await staffCaller("owner");
    const foreign = await practice(t.db);
    const foreignLocation = await location(t.db, { practiceId: foreign.id });

    const response = await postManual(
      caller.token,
      { ...MINIMAL_BODY, locationId: foreignLocation.id },
      env(bucket, ingest),
    );
    expect(response.status).toBe(422);
    expect(ingest.sent).toHaveLength(0);
  });

  it("a role without view_private_feedback cannot add a signal at all", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const ingest = recordingQueue();
    const caller = await staffCaller("external_partner");

    const response = await postManual(
      caller.token,
      MINIMAL_BODY,
      env(bucket, ingest),
    );
    expect(response.status).toBe(403);
    expect(ingest.sent).toHaveLength(0);
  });

  it("gates ONLY the attestation for roles without manage_consent (marketing)", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const ingest = recordingQueue();
    const caller = await staffCaller("marketing");

    const attested = await postManual(
      caller.token,
      {
        ...MINIMAL_BODY,
        consent: {
          choice: "practice_attested",
          channels: ["website"],
          note: "note",
        },
      },
      env(bucket, ingest),
    );
    expect(attested.status).toBe(403);
    expect(((await attested.json()) as { error: string }).error).toBe(
      "attestation_forbidden",
    );
    expect(ingest.sent).toHaveLength(0);

    // The same role CAN submit with consent unknown — the form is open.
    const unknown = await postManual(
      caller.token,
      MINIMAL_BODY,
      env(bucket, ingest),
    );
    expect(unknown.status).toBe(201);
    expect(ingest.sent).toHaveLength(1);
  });
});
