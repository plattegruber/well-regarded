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
 * window (see ../imports/csv.ts for the measured memory notes).
 */

import {
  CSV_IMPORT_MAX_BYTES,
  columnMappingSchema,
  detectColumns,
  type StaffActor,
  unknownMappingColumns,
} from "@wellregarded/core";
import { audit, schema } from "@wellregarded/db";
import { getRawImportHead, putRawImportArtifact } from "@wellregarded/sources";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import type { AppEnv } from "../bindings";
import {
  PREVIEW_WINDOW_BYTES,
  parseCsvPreview,
  sniffCsvBytes,
} from "../imports/csv";
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
 * Save the wizard's mapping onto a draft: schema-validate, check every
 * referenced column against the draft's STORED headers (a mapping naming
 * a column the file doesn't have is a 422, not a silent no-op at import
 * time), persist, audit. Only `status = draft` rows are editable.
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
  const mapping = parsed.data;

  const actor = c.get("actor");
  const db = c.get("db");

  // Unknown ids and other practices' drafts are the same 404.
  const [draft] = await db
    .select()
    .from(importDrafts)
    .where(
      and(
        eq(importDrafts.id, draftId.data),
        eq(importDrafts.practiceId, actor.practiceId),
      ),
    )
    .limit(1);
  if (!draft) return c.json({ error: "not_found" as const }, 404);
  if (draft.status !== "draft") {
    return c.json(
      { error: "not_editable" as const, status: draft.status },
      409,
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

  await db.transaction(async (tx) => {
    await tx
      .update(importDrafts)
      .set({ mapping, updatedAt: new Date() })
      .where(eq(importDrafts.id, draft.id));
    await audit(tx, {
      practiceId: actor.practiceId,
      actor: staffAuditActor(actor),
      action: "import_draft.mapping_saved",
      entityType: "import_drafts",
      entityId: draft.id,
      // Column names and targets only — mapping never holds cell values.
      payload: { targets: Object.keys(mapping) },
    });
  });

  return c.json({ importDraftId: draft.id, mapping, status: draft.status });
});
