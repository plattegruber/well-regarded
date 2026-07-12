/**
 * CSV import integration tests (issue #133): the full upload → R2 →
 * preview → draft cycle and the mapping PUT, through `app.request()`
 * against real Postgres (packages/db's template-clone harness) with the
 * in-memory R2 fake from `@wellregarded/sources/testing` injected as the
 * RAW_IMPORTS binding.
 */

import {
  type ColumnMapping,
  CSV_IMPORT_MAX_BYTES,
  resetEnvCache,
} from "@wellregarded/core";
import { schema } from "@wellregarded/db";
import { validateCsvPreviewRows } from "@wellregarded/sources";
import { InMemoryRawArtifactBucket } from "@wellregarded/sources/testing";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { practice, staffMember } from "../../../packages/db/test/factories.js";
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

const { auditLog, importDrafts } = schema;

const t = setupTestDb();

let keys: TestKeys;

beforeAll(async () => {
  keys = await generateTestKeys();
});

beforeEach(() => {
  resetEnvCache();
});

function env(bucket: InMemoryRawArtifactBucket) {
  return testEnv({
    HYPERDRIVE: {
      connectionString: withDatabase(requireDatabaseUrl(), t.databaseName),
    },
    CLERK_JWKS_PUBLIC_KEY: keys.publicKeyPem,
    RAW_IMPORTS: bucket,
  });
}

/** A practice plus an authenticated staff member of the given role. */
async function staffCaller(
  role: "owner" | "office_manager" | "front_desk" = "owner",
) {
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

const FIXTURE_CSV = [
  "Date,Stars,Review,Reviewer,Patient Email",
  "01/13/2024,5,Great cleaning,Pat L.,pat@example.com",
  '01/20/2024,4,"Kind, patient staff",Sam K.,sam@example.com',
  "02/02/2024,5,Best dentist in town,Ana P.,ana@example.com",
  "",
].join("\n");

interface UploadOptions {
  filename?: string;
  contentType?: string;
  contentLength?: number;
  body?: BodyInit;
}

async function uploadCsv(
  token: string,
  bucket: InMemoryRawArtifactBucket,
  options: UploadOptions = {},
) {
  const body = options.body ?? FIXTURE_CSV;
  const contentLength =
    options.contentLength ??
    (typeof body === "string"
      ? new TextEncoder().encode(body).byteLength
      : body instanceof Uint8Array
        ? body.byteLength
        : undefined);
  const query =
    options.filename !== undefined
      ? `?filename=${encodeURIComponent(options.filename)}`
      : "";
  const request = new Request(`http://localhost/api/imports/csv${query}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": options.contentType ?? "text/csv",
      ...(contentLength !== undefined
        ? { "Content-Length": String(contentLength) }
        : {}),
    },
    body,
    // undici requires half-duplex for stream bodies; harmless otherwise.
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
  return app.request(request, undefined, env(bucket));
}

async function putMapping(
  token: string,
  bucket: InMemoryRawArtifactBucket,
  draftId: string,
  mapping: unknown,
) {
  return app.request(
    `http://localhost/api/imports/csv/${draftId}/mapping`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(mapping),
    },
    env(bucket),
  );
}

const VALID_MAPPING: ColumnMapping = {
  occurredAt: { column: "Date", dateFormat: "MM/DD/YYYY" },
  rating: { column: "Stars", ratingScale: 5 },
  text: { column: "Review" },
  author: { column: "Reviewer" },
  patientEmail: { column: "Patient Email" },
  visibility: { constant: "private" },
  consentHint: { constant: "imported_unknown" },
};

interface UploadResponseBody {
  importDraftId: string;
  headers: string[];
  previewRows: string[][];
  detected: {
    delimiter: string;
    columns: Array<{
      index: number;
      header: string;
      suggestedTarget: string | null;
      dateFormat?: unknown;
      ratingScale?: number | null;
    }>;
  };
}

describe("POST /api/imports/csv (upload → R2 → preview → draft)", () => {
  it("stores the exact bytes under the imports key, creates a draft, returns preview + detection", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const { practice: p, staff, token } = await staffCaller("owner");

    const res = await uploadCsv(token, bucket, {
      filename: "legacy reviews.csv",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as UploadResponseBody;

    // R2: content-addressed under the imports context, exact bytes.
    expect(bucket.objects.size).toBe(1);
    const key = [...bucket.objects.keys()][0] as string;
    expect(key).toMatch(new RegExp(`^${p.id}/imports/[0-9a-f]{64}\\.csv$`));
    expect(new TextDecoder().decode(bucket.objects.get(key)?.body)).toBe(
      FIXTURE_CSV,
    );

    // Draft row.
    const [draft] = await t.db
      .select()
      .from(importDrafts)
      .where(eq(importDrafts.id, body.importDraftId));
    expect(draft).toMatchObject({
      practiceId: p.id,
      r2Key: key,
      originalFilename: "legacy reviews.csv",
      byteSize: new TextEncoder().encode(FIXTURE_CSV).byteLength,
      headers: ["Date", "Stars", "Review", "Reviewer", "Patient Email"],
      mapping: null,
      status: "draft",
      createdBy: staff.id,
    });

    // Preview: header + all 3 data rows, quoted comma intact.
    expect(body.headers).toEqual([
      "Date",
      "Stars",
      "Review",
      "Reviewer",
      "Patient Email",
    ]);
    expect(body.previewRows).toHaveLength(3);
    expect(body.previewRows[1]?.[2]).toBe("Kind, patient staff");

    // Detection prefills the wizard.
    expect(body.detected.delimiter).toBe(",");
    expect(body.detected.columns.map((c) => c.suggestedTarget)).toEqual([
      "occurredAt",
      "rating",
      "text",
      "author",
      "patientEmail",
    ]);
    expect(body.detected.columns[0]?.dateFormat).toEqual({
      format: "MM/DD/YYYY",
    });
    expect(body.detected.columns[1]?.ratingScale).toBe(5);

    // Audited in the same transaction as the insert.
    const audits = await t.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.practiceId, p.id),
          eq(auditLog.action, "import_draft.created"),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorId).toBe(staff.id);
    expect(audits[0]?.entityId).toBe(body.importDraftId);
  });

  it("previews at most 50 rows of a larger file", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const { token } = await staffCaller();
    const lines = ["Date,Review"];
    for (let i = 0; i < 80; i++) lines.push(`2024-01-02,row ${i}`);

    const res = await uploadCsv(token, bucket, { body: lines.join("\n") });
    expect(res.status).toBe(201);
    const body = (await res.json()) as UploadResponseBody;
    expect(body.previewRows).toHaveLength(50);
  });

  it("10MB fixture: preview reads back a RANGED window, never the whole object", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const { token } = await staffCaller();
    const lines = ["Date,Rating,Review"];
    while (lines.length * 36 < 10 * 1024 * 1024) {
      lines.push(`2024-01-02,5,review text payload ${lines.length}`);
    }
    const csv = `${lines.join("\n")}\n`;
    expect(csv.length).toBeGreaterThan(10 * 1024 * 1024);

    const res = await uploadCsv(token, bucket, { body: csv });
    expect(res.status).toBe(201);
    const body = (await res.json()) as UploadResponseBody;
    expect(body.previewRows).toHaveLength(50);

    // The only read was ranged to the preview window (256KB).
    expect(bucket.gets).toHaveLength(1);
    expect(bucket.gets[0]?.range).toEqual({ offset: 0, length: 256 * 1024 });
  });

  it("re-uploading identical bytes reuses the R2 object but makes a fresh draft", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const { practice: p, token } = await staffCaller();

    const first = (await (
      await uploadCsv(token, bucket)
    ).json()) as UploadResponseBody;
    const second = (await (
      await uploadCsv(token, bucket)
    ).json()) as UploadResponseBody;

    expect(bucket.writeCount).toBe(1); // content-addressed: one object
    expect(second.importDraftId).not.toBe(first.importDraftId);
    const drafts = await t.db
      .select()
      .from(importDrafts)
      .where(eq(importDrafts.practiceId, p.id));
    expect(drafts).toHaveLength(2);
    expect(drafts[0]?.r2Key).toBe(drafts[1]?.r2Key);
  });

  it("parses a BOM'd, semicolon-delimited fixture (European export)", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const { token } = await staffCaller();
    const csv = "﻿Datum;Bewertung;Text\n02.01.2024;5;prima\n";

    const res = await uploadCsv(token, bucket, { body: csv });
    expect(res.status).toBe(201);
    const body = (await res.json()) as UploadResponseBody;
    // BOM stripped: the first header is clean.
    expect(body.headers).toEqual(["Datum", "Bewertung", "Text"]);
    expect(body.detected.delimiter).toBe(";");
  });

  it("rejects XLSX magic bytes with 415 and a human message; nothing stored", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const { practice: p, token } = await staffCaller();
    const xlsx = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00,
    ]);

    const res = await uploadCsv(token, bucket, { body: xlsx });
    expect(res.status).toBe(415);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe(
      "That doesn't look like a CSV. Export as CSV from Excel first.",
    );
    expect(bucket.objects.size).toBe(0);
    expect(
      await t.db
        .select()
        .from(importDrafts)
        .where(eq(importDrafts.practiceId, p.id)),
    ).toHaveLength(0);
  });

  it("rejects UTF-16 files with a save-as-UTF-8 message", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const { token } = await staffCaller();
    const utf16 = new Uint8Array([0xff, 0xfe, 0x44, 0x00, 0x61, 0x00]);

    const res = await uploadCsv(token, bucket, { body: utf16 });
    expect(res.status).toBe(415);
    expect(((await res.json()) as { message: string }).message).toMatch(
      /UTF-16/,
    );
  });

  it("rejects multipart/form-data with instructions to send a raw body", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const { token } = await staffCaller();
    const res = await uploadCsv(token, bucket, {
      contentType: "multipart/form-data; boundary=x",
    });
    expect(res.status).toBe(415);
    expect(bucket.objects.size).toBe(0);
  });

  it("rejects a Content-Length over the 50MB cap before reading the body", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const { token } = await staffCaller();
    const res = await uploadCsv(token, bucket, {
      contentLength: CSV_IMPORT_MAX_BYTES + 1,
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string; maxBytes: number };
    expect(body.error).toBe("too_large");
    expect(body.maxBytes).toBe(CSV_IMPORT_MAX_BYTES);
    expect(bucket.objects.size).toBe(0);
  });

  it("rejects 50MB+1 streamed bytes MID-STREAM when the declaration lied", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const { practice: p, token } = await staffCaller();

    // Declares exactly the cap, then streams one byte more: the byte
    // counter must abort during the read, not after buffering everything.
    const chunk = new Uint8Array(1024 * 1024).fill(0x61); // 1MB of 'a'
    let sent = 0;
    const overshoot = CSV_IMPORT_MAX_BYTES + 1;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= overshoot) {
          controller.close();
          return;
        }
        const next = chunk.slice(
          0,
          Math.min(chunk.byteLength, overshoot - sent),
        );
        sent += next.byteLength;
        controller.enqueue(next);
      },
    });

    const res = await uploadCsv(token, bucket, {
      body,
      contentLength: CSV_IMPORT_MAX_BYTES,
    });
    expect(res.status).toBe(413);
    expect(bucket.objects.size).toBe(0);
    expect(
      await t.db
        .select()
        .from(importDrafts)
        .where(eq(importDrafts.practiceId, p.id)),
    ).toHaveLength(0);
  });

  it("rejects an empty upload", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const { token } = await staffCaller();
    const res = await uploadCsv(token, bucket, { body: "" });
    expect(res.status).toBe(400);
  });

  it("422s a file with no parseable header row", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const { token } = await staffCaller();
    const res = await uploadCsv(token, bucket, { body: "   \n \n" });
    expect(res.status).toBe(422);
  });

  it("front_desk (manage_settings: deny) → 403; office_manager → 201", async () => {
    const bucket = new InMemoryRawArtifactBucket();
    const denied = await staffCaller("front_desk");
    const deniedRes = await uploadCsv(denied.token, bucket);
    expect(deniedRes.status).toBe(403);
    expect(await deniedRes.json()).toEqual({
      error: "forbidden",
      reason: "permission",
    });
    expect(bucket.objects.size).toBe(0);

    const allowed = await staffCaller("office_manager");
    const allowedRes = await uploadCsv(allowed.token, bucket);
    expect(allowedRes.status).toBe(201);
  });
});

describe("PUT /api/imports/csv/:draftId/mapping", () => {
  async function uploadedDraft() {
    const bucket = new InMemoryRawArtifactBucket();
    const caller = await staffCaller("owner");
    const res = await uploadCsv(caller.token, bucket);
    expect(res.status).toBe(201);
    const body = (await res.json()) as UploadResponseBody;
    return { ...caller, bucket, draftId: body.importDraftId };
  }

  it("validates against stored headers, persists, audits", async () => {
    const {
      practice: p,
      staff,
      bucket,
      token,
      draftId,
    } = await uploadedDraft();

    const res = await putMapping(token, bucket, draftId, VALID_MAPPING);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      importDraftId: draftId,
      mapping: VALID_MAPPING,
      status: "draft",
    });

    const [row] = await t.db
      .select()
      .from(importDrafts)
      .where(eq(importDrafts.id, draftId));
    expect(row?.mapping).toEqual(VALID_MAPPING);
    expect(row?.updatedAt.getTime()).toBeGreaterThanOrEqual(
      row?.createdAt.getTime() ?? Number.POSITIVE_INFINITY,
    );

    const audits = await t.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.practiceId, p.id),
          eq(auditLog.action, "import_draft.mapping_saved"),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorId).toBe(staff.id);
    expect(audits[0]?.entityId).toBe(draftId);
  });

  it("422s unknown column names, naming them; nothing persisted", async () => {
    const { bucket, token, draftId } = await uploadedDraft();

    const res = await putMapping(token, bucket, draftId, {
      ...VALID_MAPPING,
      text: { column: "Reviews" }, // stored header is "Review"
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; columns: unknown };
    expect(body.error).toBe("unknown_columns");
    expect(body.columns).toEqual([{ field: "text", column: "Reviews" }]);

    const [row] = await t.db
      .select()
      .from(importDrafts)
      .where(eq(importDrafts.id, draftId));
    expect(row?.mapping).toBeNull();
  });

  it("400s a schema-invalid mapping with field-level issues", async () => {
    const { bucket, token, draftId } = await uploadedDraft();

    // Missing occurredAt entirely.
    const missingWhen = await putMapping(token, bucket, draftId, {
      text: { column: "Review" },
    });
    expect(missingWhen.status).toBe(400);
    const body = (await missingWhen.json()) as {
      error: string;
      issues: Array<{ path: string }>;
    };
    expect(body.error).toBe("invalid_mapping");
    expect(body.issues.map((i) => i.path)).toContain("occurredAt");

    // Neither text nor rating.
    const noWhat = await putMapping(token, bucket, draftId, {
      occurredAt: { column: "Date", dateFormat: "MM/DD/YYYY" },
    });
    expect(noWhat.status).toBe(400);
  });

  it("cross-practice drafts are 404, same as unknown ids", async () => {
    const { bucket, draftId } = await uploadedDraft();
    const other = await staffCaller("owner");

    const res = await putMapping(other.token, bucket, draftId, VALID_MAPPING);
    expect(res.status).toBe(404);

    const unknown = await putMapping(
      other.token,
      bucket,
      "00000000-0000-4000-8000-00000000dead",
      VALID_MAPPING,
    );
    expect(unknown.status).toBe(404);
    expect(await res.json()).toEqual(await unknown.json());
  });

  it("409s a draft that is no longer editable", async () => {
    const { bucket, token, draftId } = await uploadedDraft();
    await t.db
      .update(importDrafts)
      .set({ status: "confirmed" })
      .where(eq(importDrafts.id, draftId));

    const res = await putMapping(token, bucket, draftId, VALID_MAPPING);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "not_editable",
      status: "confirmed",
    });
  });

  it("front_desk cannot save mappings either", async () => {
    const { practice: p, bucket, draftId } = await uploadedDraft();
    const clerk = await staffMember(t.db, {
      practiceId: p.id,
      clerkUserId: `user_frontdesk_${Math.random().toString(36).slice(2, 8)}`,
      role: "front_desk",
    });
    const token = await signSessionToken(keys, {
      sub: clerk.clerkUserId,
      claims: { o: { id: p.clerkOrgId, rol: "member" } },
    });

    const res = await putMapping(token, bucket, draftId, VALID_MAPPING);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Wizard endpoints (issue #134): GET draft+preview, validate, start.
// ---------------------------------------------------------------------------

async function uploadedDraftFixture(csv: string = FIXTURE_CSV) {
  const bucket = new InMemoryRawArtifactBucket();
  const caller = await staffCaller("owner");
  const res = await uploadCsv(caller.token, bucket, { body: csv });
  expect(res.status).toBe(201);
  const body = (await res.json()) as UploadResponseBody;
  return { ...caller, bucket, draftId: body.importDraftId };
}

function apiRequest(
  token: string,
  bucket: InMemoryRawArtifactBucket,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) {
  return app.request(
    `http://localhost/api/imports${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    env(bucket),
  );
}

describe("GET /api/imports/csv/:draftId (resume a draft)", () => {
  it("returns the draft, its preview rows, detection, and wizard state", async () => {
    const { token, bucket, draftId } = await uploadedDraftFixture();
    await putMapping(token, bucket, draftId, VALID_MAPPING);

    const res = await apiRequest(token, bucket, "GET", `/csv/${draftId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      importDraftId: draftId,
      status: "draft",
      originalFilename: "upload.csv",
      headers: ["Date", "Stars", "Review", "Reviewer", "Patient Email"],
      mapping: VALID_MAPPING,
      attestationNote: null,
      wizardStep: null,
    });
    expect(body.previewRows).toHaveLength(3);
    const detected = body.detected as {
      columns: Array<{ suggestedTarget: string | null }>;
    };
    expect(detected.columns.map((c) => c.suggestedTarget)).toEqual([
      "occurredAt",
      "rating",
      "text",
      "author",
      "patientEmail",
    ]);
  });

  it("cross-practice reads are 404", async () => {
    const { bucket, draftId } = await uploadedDraftFixture();
    const other = await staffCaller("owner");
    const res = await apiRequest(other.token, bucket, "GET", `/csv/${draftId}`);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/imports/csv/:draftId/validate", () => {
  const MESSY_CSV = [
    "Date,Stars,Review,Reviewer,Patient Email",
    "01/13/2024,5,Great cleaning,Pat L.,pat@example.com",
    "13/45/2023,4,Nice visit,Sam K.,sam@example.com", // bad date
    "02/02/2024,9,Too good,Ana P.,ana@example.com", // rating off scale
    "02/03/2024,5,Lovely,,", // empty optionals → warnings only
    "",
  ].join("\n");

  it("returns EXACTLY what the Workflow's validator (#135) produces for the fixture", async () => {
    const { token, bucket, draftId } = await uploadedDraftFixture(MESSY_CSV);

    const res = await apiRequest(
      token,
      bucket,
      "POST",
      `/csv/${draftId}/validate`,
      { mapping: VALID_MAPPING },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // The shared-code-path requirement, asserted literally: the endpoint's
    // answer must equal a direct call to the shared validator over the
    // same rows.
    const headers = ["Date", "Stars", "Review", "Reviewer", "Patient Email"];
    const rows = [
      ["01/13/2024", "5", "Great cleaning", "Pat L.", "pat@example.com"],
      ["13/45/2023", "4", "Nice visit", "Sam K.", "sam@example.com"],
      ["02/02/2024", "9", "Too good", "Ana P.", "ana@example.com"],
      ["02/03/2024", "5", "Lovely", "", ""],
    ];
    expect(body).toEqual({
      importDraftId: draftId,
      ...JSON.parse(
        JSON.stringify(validateCsvPreviewRows(VALID_MAPPING, headers, rows)),
      ),
    });
    expect(body.rowCount).toBe(4);
    expect(body.okCount).toBe(2);
    expect(body.failingRowCount).toBe(2);
  });

  it("falls back to the saved mapping; 422 mapping_missing when there is none", async () => {
    const { token, bucket, draftId } = await uploadedDraftFixture(MESSY_CSV);

    const missing = await apiRequest(
      token,
      bucket,
      "POST",
      `/csv/${draftId}/validate`,
    );
    expect(missing.status).toBe(422);
    expect(((await missing.json()) as { error: string }).error).toBe(
      "mapping_missing",
    );

    await putMapping(token, bucket, draftId, VALID_MAPPING);
    const saved = await apiRequest(
      token,
      bucket,
      "POST",
      `/csv/${draftId}/validate`,
    );
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { rowCount: number }).rowCount).toBe(4);
  });

  it("422s a candidate mapping that names columns the file lacks", async () => {
    const { token, bucket, draftId } = await uploadedDraftFixture();
    const res = await apiRequest(
      token,
      bucket,
      "POST",
      `/csv/${draftId}/validate`,
      { mapping: { ...VALID_MAPPING, text: { column: "Reviews" } } },
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe(
      "unknown_columns",
    );
  });
});

describe("POST /api/imports/csv/:draftId/start (server-side guardrail)", () => {
  it("rejects an unmapped draft with the shared issues", async () => {
    const { token, bucket, draftId } = await uploadedDraftFixture();
    const res = await apiRequest(
      token,
      bucket,
      "POST",
      `/csv/${draftId}/start`,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: string;
      issues: Array<{ code: string }>;
    };
    expect(body.error).toBe("not_ready");
    expect(body.issues.map((i) => i.code)).toEqual(["mapping_missing"]);
  });

  it("rejects a private+PII mapping whose consent question is unanswered", async () => {
    const { token, bucket, draftId } = await uploadedDraftFixture();
    const { consentHint: _drop, ...noConsent } = VALID_MAPPING;
    await putMapping(token, bucket, draftId, noConsent);

    const res = await apiRequest(
      token,
      bucket,
      "POST",
      `/csv/${draftId}/start`,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { issues: Array<{ code: string }> };
    expect(body.issues.map((i) => i.code)).toEqual(["consent_missing"]);
  });

  it("confirms a complete draft, audits, and refuses to run twice", async () => {
    const {
      practice: p,
      token,
      bucket,
      draftId,
    } = await uploadedDraftFixture();
    await putMapping(token, bucket, draftId, VALID_MAPPING);

    const res = await apiRequest(
      token,
      bucket,
      "POST",
      `/csv/${draftId}/start`,
    );
    expect(res.status).toBe(200);
    // No CSV_IMPORT binding in this env: confirmed, workflow not started.
    expect(await res.json()).toEqual({
      importDraftId: draftId,
      status: "confirmed",
      workflowInstanceId: null,
    });

    const [row] = await t.db
      .select()
      .from(importDrafts)
      .where(eq(importDrafts.id, draftId));
    expect(row?.status).toBe("confirmed");

    const audits = await t.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.practiceId, p.id),
          eq(auditLog.action, "import_draft.confirmed"),
        ),
      );
    expect(audits).toHaveLength(1);

    const again = await apiRequest(
      token,
      bucket,
      "POST",
      `/csv/${draftId}/start`,
    );
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({
      error: "not_editable",
      status: "confirmed",
    });
  });

  it("creates one wr-csv-import Workflow instance when the binding exists", async () => {
    const {
      practice: p,
      token,
      bucket,
      draftId,
    } = await uploadedDraftFixture();
    await putMapping(token, bucket, draftId, VALID_MAPPING);

    const created: unknown[] = [];
    const workflowEnv = {
      ...env(bucket),
      CSV_IMPORT: {
        create: async (options: { params?: unknown }) => {
          created.push(options.params);
          return { id: "wf-instance-1" };
        },
      },
    };
    const res = await app.request(
      `http://localhost/api/imports/csv/${draftId}/start`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` } },
      workflowEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      importDraftId: draftId,
      status: "confirmed",
      workflowInstanceId: "wf-instance-1",
    });
    expect(created).toEqual([
      {
        importDraftId: draftId,
        practiceId: p.id,
        requestId: expect.any(String),
      },
    ]);
  });
  it("front_desk cannot start an import", async () => {
    const {
      practice: p,
      bucket,
      token,
      draftId,
    } = await uploadedDraftFixture();
    await putMapping(token, bucket, draftId, VALID_MAPPING);
    const clerk = await staffMember(t.db, {
      practiceId: p.id,
      clerkUserId: `user_frontdesk_${Math.random().toString(36).slice(2, 8)}`,
      role: "front_desk",
    });
    const clerkToken = await signSessionToken(keys, {
      sub: clerk.clerkUserId,
      claims: { o: { id: p.clerkOrgId, rol: "member" } },
    });
    const res = await apiRequest(
      clerkToken,
      bucket,
      "POST",
      `/csv/${draftId}/start`,
    );
    expect(res.status).toBe(403);
  });
});
