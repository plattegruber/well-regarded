/**
 * CSV import endpoints (issue #133, Epic #8), mounted under the staff-auth
 * group at /api/imports — the entry point of the import journey (upload →
 * wizard #134 → Workflow #135 → report #137). Both routes are gated by
 * `requirePermission("manage_settings")` (matrix: owner, office_manager,
 * multi_location_admin) and audited in the same transaction as their
 * mutation.
 *
 * UPLOAD TRANSPORT & SIZE CAP (req. 1, verified against platform limits)
 * ----------------------------------------------------------------------
 * The client sends the file as the RAW request body (`fetch(url, { body:
 * file })`), `text/csv` — deliberately not multipart/form-data, which
 * buffers and complicates streaming for zero benefit here. One plain
 * request is all we need: Cloudflare's per-request body limit is 100MB on
 * Free/Pro plans (200MB Business, 500MB Enterprise), so our 50MB cap fits
 * every plan with 2x headroom and no chunked/multipart protocol is
 * required. The cap is enforced twice: the `Content-Length` header up
 * front (413 before reading anything), and a streamed byte counter that
 * aborts mid-body the moment more bytes arrive than declared/allowed — a
 * lying client cannot make us buffer past the cap.
 *
 * Why the body is buffered (once, as bytes) rather than piped straight to
 * R2: the storage key is content-addressed (`{practiceId}/imports/
 * {sha256}.csv`, issue #100's scheme extended in `@wellregarded/sources`),
 * and the hash of the full body must exist before the key does. A pure
 * pipe would require a temp-key write + server-side copy R2 doesn't
 * offer. A single 50MB `Uint8Array` (never a string — UTF-16 would double
 * it) is well within the isolate's 128MB; the streamed counter above
 * guarantees that's the ceiling. Preview reads back only a 256KB ranged
 * window (see `csvPreview.ts` in @wellregarded/core — shared with the
 * wizard, #134 — for the measured memory notes).
 */

import {
  type ColumnMapping,
  CSV_IMPORT_MAX_BYTES,
  columnMappingSchema,
  detectColumns,
  IMPORT_RUN_ERROR_SAMPLE_CAP,
  type ImportRunErrorSample,
  PREVIEW_WINDOW_BYTES,
  parseCsvPreview,
  SOURCE_KINDS,
  type SourceKind,
  type StaffActor,
  sniffCsvBytes,
  unknownMappingColumns,
} from "@wellregarded/core";
import {
  audit,
  confirmImportDraft,
  getImportDraft,
  getImportRunSummary,
  type ImportDraft,
  listImportRuns,
  saveImportDraftMapping,
  schema,
} from "@wellregarded/db";
import {
  getRawImportHead,
  parseRowRef,
  putRawImportArtifact,
  type RawImportBucket,
  readCsvBatchRows,
  validateCsvPreviewRows,
} from "@wellregarded/sources";
import { Hono } from "hono";
import { z } from "zod";

import type { AppEnv } from "../bindings";
import { requirePermission } from "../middleware/staffAuth";

const { importDrafts } = schema;

function staffAuditActor(actor: StaffActor): { type: "staff"; id: string } {
  return { type: "staff", id: actor.staffId };
}

/** Display-only; never used as a path. Strip directories, cap length. */
function sanitizeFilename(raw: string | undefined): string {
  const name = (raw ?? "").split(/[/\\]/).pop()?.trim() ?? "";
  if (name === "") return "upload.csv";
  return name.slice(0, 255);
}

type BodyReadResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; status: 400 | 413 };

/**
 * Read the body into a single buffer sized by the (already-validated)
 * Content-Length, counting as we go: any byte past the declaration aborts
 * the read immediately — 413 if that also busts the global cap, 400 for a
 * plain declaration mismatch (either way we never buffer unbounded input).
 */
async function readBodyCapped(
  body: ReadableStream<Uint8Array>,
  declaredLength: number,
): Promise<BodyReadResult> {
  const buffer = new Uint8Array(declaredLength);
  let received = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (received + value.byteLength > declaredLength) {
        return {
          ok: false,
          status:
            received + value.byteLength > CSV_IMPORT_MAX_BYTES ? 413 : 400,
        };
      }
      buffer.set(value, received);
      received += value.byteLength;
    }
  } finally {
    // Abandoned mid-read on rejection: release the lock and drop the rest.
    reader.cancel().catch(() => {});
  }
  if (received !== declaredLength) return { ok: false, status: 400 };
  return { ok: true, bytes: buffer };
}

export const importRoutes = new Hono<AppEnv>();

importRoutes.use("*", requirePermission("manage_settings"));

/**
 * Upload a CSV: stream-count the body, sniff it, store it content-addressed
 * in R2 (`RAW_IMPORTS`), parse header + first 50 rows from a 256KB ranged
 * read-back, persist an `import_drafts` row, and return the preview plus
 * per-column auto-detection for the wizard to prefill.
 *
 * `?filename=` carries the original name (display only) — a raw-body
 * upload has no multipart filename field.
 */
importRoutes.post("/csv", async (c) => {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.toLowerCase().startsWith("multipart/")) {
    return c.json(
      {
        error: "unsupported_media_type" as const,
        message:
          "Send the CSV as the raw request body (Content-Type: text/csv), not multipart/form-data.",
      },
      415,
    );
  }

  const declaredHeader = c.req.header("content-length");
  const declaredLength = declaredHeader ? Number(declaredHeader) : Number.NaN;
  if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
    return c.json(
      {
        error: "length_required" as const,
        message: "Send a Content-Length header (raw-body upload).",
      },
      411,
    );
  }
  if (declaredLength > CSV_IMPORT_MAX_BYTES) {
    return c.json(
      {
        error: "too_large" as const,
        maxBytes: CSV_IMPORT_MAX_BYTES,
        message: "CSV uploads are capped at 50MB. Split the export and retry.",
      },
      413,
    );
  }
  const body = c.req.raw.body;
  if (declaredLength === 0 || body === null) {
    return c.json(
      { error: "empty_body" as const, message: "The upload was empty." },
      400,
    );
  }

  const read = await readBodyCapped(body, declaredLength);
  if (!read.ok) {
    return read.status === 413
      ? c.json(
          {
            error: "too_large" as const,
            maxBytes: CSV_IMPORT_MAX_BYTES,
            message:
              "CSV uploads are capped at 50MB. Split the export and retry.",
          },
          413,
        )
      : c.json(
          {
            error: "length_mismatch" as const,
            message: "The body did not match its Content-Length.",
          },
          400,
        );
  }
  const bytes = read.bytes;

  const sniff = sniffCsvBytes(bytes);
  if (!sniff.ok) {
    if (sniff.reason === "empty") {
      return c.json(
        { error: "empty_body" as const, message: "The upload was empty." },
        400,
      );
    }
    return c.json(
      {
        error: "unsupported_media_type" as const,
        message:
          sniff.reason === "utf16"
            ? "That file is UTF-16 encoded. Save it as UTF-8 CSV and retry."
            : "That doesn't look like a CSV. Export as CSV from Excel first.",
      },
      415,
    );
  }

  const actor = c.get("actor");

  // Store BEFORE anything references the key (the same store-before rule
  // as the pipeline's raw artifacts). Idempotent on identical bytes.
  const { key } = await putRawImportArtifact(c.env.RAW_IMPORTS, {
    practiceId: actor.practiceId,
    bytes,
  });

  // Read back only the head — never the whole (possibly 50MB) object.
  const head = await getRawImportHead(
    c.env.RAW_IMPORTS,
    key,
    PREVIEW_WINDOW_BYTES,
  );
  const preview = parseCsvPreview(head.bytes, { truncated: head.truncated });
  if (preview === null) {
    return c.json(
      {
        error: "unparseable_csv" as const,
        message: "Couldn't find a header row in that file.",
      },
      422,
    );
  }

  const originalFilename = sanitizeFilename(c.req.query("filename"));
  const draft = await c.get("db").transaction(async (tx) => {
    const [inserted] = await tx
      .insert(importDrafts)
      .values({
        practiceId: actor.practiceId,
        r2Key: key,
        originalFilename,
        byteSize: bytes.byteLength,
        headers: preview.headers,
        createdBy: actor.staffId,
      })
      .returning();
    if (!inserted) throw new Error("import draft insert returned no row");
    await audit(tx, {
      practiceId: actor.practiceId,
      actor: staffAuditActor(actor),
      action: "import_draft.created",
      entityType: "import_drafts",
      entityId: inserted.id,
      payload: {
        r2Key: key,
        originalFilename,
        byteSize: bytes.byteLength,
        headerCount: preview.headers.length,
      },
    });
    return inserted;
  });

  return c.json(
    {
      importDraftId: draft.id,
      headers: preview.headers,
      previewRows: preview.previewRows,
      detected: {
        delimiter: preview.delimiter,
        columns: detectColumns(preview.headers, preview.previewRows),
      },
    },
    201,
  );
});

/**
 * Read back the head of a draft's stored object and parse the preview —
 * the same ranged-window discipline as the upload path (never the whole,
 * possibly 50MB, object).
 */
async function draftPreview(
  bucket: RawImportBucket,
  draft: ImportDraft,
): Promise<ReturnType<typeof parseCsvPreview>> {
  const head = await getRawImportHead(
    bucket,
    draft.r2Key,
    PREVIEW_WINDOW_BYTES,
  );
  return parseCsvPreview(head.bytes, { truncated: head.truncated });
}

/**
 * Fetch a draft with its preview + per-column detection — what the mapping
 * wizard (#134) renders when it resumes a draft the upload response no
 * longer has in hand. Same body shape as the upload response, plus the
 * persisted wizard state (`mapping`, `attestationNote`, `wizardStep`).
 */
importRoutes.get("/csv/:draftId", async (c) => {
  const draftId = z.uuid().safeParse(c.req.param("draftId"));
  if (!draftId.success) return c.json({ error: "not_found" as const }, 404);

  const actor = c.get("actor");
  const draft = await getImportDraft(
    c.get("db"),
    actor.practiceId,
    draftId.data,
  );
  if (!draft) return c.json({ error: "not_found" as const }, 404);

  const preview = await draftPreview(c.env.RAW_IMPORTS, draft);
  if (preview === null) {
    // It parsed at upload time; losing that now is an us-problem, not a
    // client mistake.
    return c.json({ error: "preview_unavailable" as const }, 500);
  }

  return c.json({
    importDraftId: draft.id,
    status: draft.status,
    originalFilename: draft.originalFilename,
    byteSize: draft.byteSize,
    headers: draft.headers,
    mapping: draft.mapping,
    attestationNote: draft.attestationNote,
    wizardStep: draft.wizardStep,
    previewRows: preview.previewRows,
    detected: {
      delimiter: preview.delimiter,
      columns: detectColumns(draft.headers, preview.previewRows),
    },
  });
});

/**
 * Save the wizard's mapping onto a draft: schema-validate, check every
 * referenced column against the draft's STORED headers (a mapping naming
 * a column the file doesn't have is a 422, not a silent no-op at import
 * time), persist, audit. Only `status = draft` rows are editable. The
 * mechanics live in `saveImportDraftMapping` (@wellregarded/db) — shared
 * with the dashboard wizard's actions so the two front doors cannot
 * drift.
 */
importRoutes.put("/csv/:draftId/mapping", async (c) => {
  const draftId = z.uuid().safeParse(c.req.param("draftId"));
  if (!draftId.success) return c.json({ error: "not_found" as const }, 404);

  const parsed = columnMappingSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json(
      {
        error: "invalid_mapping" as const,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      400,
    );
  }

  const actor = c.get("actor");
  const result = await saveImportDraftMapping(c.get("db"), {
    practiceId: actor.practiceId,
    actor: staffAuditActor(actor),
    draftId: draftId.data,
    mapping: parsed.data,
  });

  switch (result.outcome) {
    // Unknown ids and other practices' drafts are the same 404.
    case "not_found":
      return c.json({ error: "not_found" as const }, 404);
    case "not_editable":
      return c.json(
        { error: "not_editable" as const, status: result.status },
        409,
      );
    case "unknown_columns":
      return c.json(
        {
          error: "unknown_columns" as const,
          columns: result.columns,
          message: "The mapping references columns this file does not have.",
        },
        422,
      );
    case "ok":
      return c.json({
        importDraftId: result.draft.id,
        mapping: result.draft.mapping,
        status: result.draft.status,
      });
  }
});

/**
 * Validation preview (issue #134 step 2): run a mapping over the draft's
 * preview rows and report, per failing row, what is wrong and how to fix
 * it. Server-computed with `validateCsvPreviewRows` — a reshaping of
 * `validateCsvRow`, the EXACT validator the import Workflow (#135) runs
 * over the full file, so the preview cannot lie. The body may carry a candidate `{ mapping }` (the wizard validates
 * what is on screen); with no body the draft's saved mapping is used.
 */
importRoutes.post("/csv/:draftId/validate", async (c) => {
  const draftId = z.uuid().safeParse(c.req.param("draftId"));
  if (!draftId.success) return c.json({ error: "not_found" as const }, 404);

  const actor = c.get("actor");
  const draft = await getImportDraft(
    c.get("db"),
    actor.practiceId,
    draftId.data,
  );
  if (!draft) return c.json({ error: "not_found" as const }, 404);

  const body = await c.req.json().catch(() => null);
  let mapping: ColumnMapping;
  if (body !== null && typeof body === "object" && "mapping" in body) {
    const parsed = columnMappingSchema.safeParse(
      (body as { mapping: unknown }).mapping,
    );
    if (!parsed.success) {
      return c.json(
        {
          error: "invalid_mapping" as const,
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
        400,
      );
    }
    mapping = parsed.data;
  } else if (draft.mapping !== null) {
    mapping = draft.mapping;
  } else {
    return c.json(
      {
        error: "mapping_missing" as const,
        message: "Save a column mapping before validating.",
      },
      422,
    );
  }

  const unknown = unknownMappingColumns(mapping, draft.headers);
  if (unknown.length > 0) {
    return c.json(
      {
        error: "unknown_columns" as const,
        columns: unknown,
        message: "The mapping references columns this file does not have.",
      },
      422,
    );
  }

  const preview = await draftPreview(c.env.RAW_IMPORTS, draft);
  if (preview === null) {
    return c.json({ error: "preview_unavailable" as const }, 500);
  }

  return c.json({
    importDraftId: draft.id,
    ...validateCsvPreviewRows(mapping, draft.headers, preview.previewRows),
  });
});

// ---------------------------------------------------------------------------
// Import runs (issue #137) — the report UI's API surface. Same
// manage_settings gate as everything on this router (re-checked per
// request by the group middleware — the failures CSV URL gets shared
// around an office, and each GET re-authenticates and re-authorizes).
// ---------------------------------------------------------------------------

/** Newest-first practice-scoped run listing (cursor-paginated). */
importRoutes.get("/runs", async (c) => {
  const sourceKindParam = c.req.query("source_kind");
  let sourceKind: SourceKind | undefined;
  if (sourceKindParam !== undefined) {
    if (!(SOURCE_KINDS as readonly string[]).includes(sourceKindParam)) {
      return c.json({ error: "invalid_source_kind" as const }, 400);
    }
    sourceKind = sourceKindParam as SourceKind;
  }
  const actor = c.get("actor");
  const page = await listImportRuns(c.get("db"), actor.practiceId, {
    ...(sourceKind !== undefined ? { sourceKind } : {}),
    ...(c.req.query("cursor") !== undefined
      ? { cursor: c.req.query("cursor") as string }
      : {}),
  });
  return c.json({
    runs: page.runs.map((run) => ({
      id: run.id,
      sourceKind: run.sourceKind,
      trigger: run.trigger,
      status: run.status,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      created: run.created,
      merged: run.merged,
      skipped: run.skipped,
      failed: run.failed,
      stats: run.stats,
    })),
    nextCursor: page.nextCursor ?? null,
  });
});

/** RFC 4180 cell escaping — quote when the value needs it. */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function csvLine(cells: readonly string[]): string {
  return cells.map(csvCell).join(",");
}

/** Strip the Workflow's "Row N: " prefix — the CSV has a column for it. */
function sampleReason(sample: ImportRunErrorSample, rowNumber: number | null) {
  if (rowNumber !== null) {
    return sample.message.replace(new RegExp(`^Row ${rowNumber}: `), "");
  }
  return sample.message;
}

/**
 * Download a run's failures as CSV (issue #137 req. 1): `row_number,
 * reason, <original columns...>` so the office manager can fix exactly
 * those rows in Excel and re-import the corrected file as a new draft.
 *
 * Honesty contract (the report never guesses):
 * - row-validation failures (`payloadRef: "row:N"`) get their ORIGINAL
 *   cell values reconstructed from the run's batch artifacts in R2 — the
 *   samples themselves don't store values, but the batches ship every row;
 * - pipeline-stage failures (no row number) appear with their stage and
 *   payload ref in the reason, values blank;
 * - past the `error_samples` cap, a final note row states how many failed
 *   rows were counted but not individually recorded.
 */
importRoutes.get("/runs/:importRunId/failures.csv", async (c) => {
  const importRunId = z.uuid().safeParse(c.req.param("importRunId"));
  if (!importRunId.success) return c.json({ error: "not_found" as const }, 404);

  const actor = c.get("actor");
  const summary = await getImportRunSummary(
    c.get("db"),
    actor.practiceId,
    importRunId.data,
    { errorSampleLimit: IMPORT_RUN_ERROR_SAMPLE_CAP },
  );
  if (!summary) return c.json({ error: "not_found" as const }, 404);

  const samples = summary.errorSamples.map((sample) => ({
    sample,
    rowNumber: parseRowRef(sample.payloadRef),
  }));
  const rowNumbers = samples
    .map((entry) => entry.rowNumber)
    .filter((n): n is number => n !== null);
  const lookup = await readCsvBatchRows(
    c.env.RAW_ARTIFACTS,
    summary.run.rawArtifactKeys,
    rowNumbers,
  );

  const headers = lookup.headers ?? [];
  const lines = [csvLine(["row_number", "reason", ...headers])];
  // Row failures first, in row order; stage-level failures after.
  samples.sort((a, b) => {
    if (a.rowNumber === null && b.rowNumber === null) return 0;
    if (a.rowNumber === null) return 1;
    if (b.rowNumber === null) return -1;
    return a.rowNumber - b.rowNumber;
  });
  for (const { sample, rowNumber } of samples) {
    const values = rowNumber !== null ? (lookup.rows.get(rowNumber) ?? []) : [];
    const reason =
      rowNumber !== null
        ? sampleReason(sample, rowNumber)
        : `[${sample.stage}] ${sample.message} (ref: ${sample.payloadRef})`;
    lines.push(
      csvLine([
        rowNumber !== null ? String(rowNumber) : "",
        reason,
        ...values.map(String),
      ]),
    );
  }
  const unrecorded = summary.errorCount - samples.length;
  if (unrecorded > 0) {
    // The cap is an Epic #6 decision (#111); the report is honest about it.
    lines.push(
      csvLine([
        "",
        `${unrecorded} additional failed row${unrecorded === 1 ? "" : "s"} not individually recorded (only the first ${IMPORT_RUN_ERROR_SAMPLE_CAP} failures keep details)`,
      ]),
    );
  }

  return c.body(`${lines.join("\r\n")}\r\n`, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="import-${importRunId.data}-failures.csv"`,
  });
});

/**
 * Confirm & start (issue #134 step 4 / req. 6): re-run the shared start
 * guardrail server-side, flip the draft to `confirmed`, and create one
 * `wr-csv-import` Workflow instance (#135, docs/csv-import.md §
 * Triggering). A wizard (or API client) can never confirm a draft this
 * endpoint would reject, because the guardrail is one function
 * (`importStartIssues`).
 *
 * The Workflow create is deliberately AFTER the commit and non-fatal:
 * `confirmed` is the durable state the Workflow consumes, so a failed
 * create leaves a retriable draft (re-trigger via this endpoint's
 * semantics or the Wrangler CLI), never a half-started one.
 */
importRoutes.post("/csv/:draftId/start", async (c) => {
  const draftId = z.uuid().safeParse(c.req.param("draftId"));
  if (!draftId.success) return c.json({ error: "not_found" as const }, 404);

  const actor = c.get("actor");
  const result = await confirmImportDraft(c.get("db"), {
    practiceId: actor.practiceId,
    actor: staffAuditActor(actor),
    draftId: draftId.data,
  });

  switch (result.outcome) {
    case "not_found":
      return c.json({ error: "not_found" as const }, 404);
    case "not_editable":
      return c.json(
        { error: "not_editable" as const, status: result.status },
        409,
      );
    case "blocked":
      return c.json(
        { error: "not_ready" as const, issues: result.issues },
        422,
      );
    case "ok": {
      let workflowInstanceId: string | null = null;
      const workflow = c.env.CSV_IMPORT;
      if (workflow) {
        try {
          const instance = await workflow.create({
            params: {
              importDraftId: result.draft.id,
              practiceId: actor.practiceId,
              requestId: c.get("requestId"),
            },
          });
          workflowInstanceId = instance.id;
        } catch (error) {
          // Non-fatal by design (see route doc): the draft is confirmed.
          c.get("logger").error("csv-import workflow create failed", {
            stage: "imports.start",
            importDraftId: result.draft.id,
            error,
          });
        }
      } else {
        c.get("logger").warn(
          "CSV_IMPORT binding missing — draft confirmed, workflow not started",
          { stage: "imports.start", importDraftId: result.draft.id },
        );
      }
      return c.json({
        importDraftId: result.draft.id,
        status: result.draft.status,
        workflowInstanceId,
      });
    }
  }
});
