/**
 * `import_drafts` Workflow-helper coverage (issue #135): practice-scoped
 * reads, the draft↔run linkage, terminal supersede — plus
 * `setImportRunArtifactKeys` (the chunk step's post-parse write) — against
 * a real Postgres via the template-clone harness.
 */

import { describe, expect, it } from "vitest";

import { importDraft, importRun, practice } from "../../test/factories.js";
import { setupTestDb } from "../../test/harness.js";
import { getImportRunArtifactKeys } from "./dedupe.js";
import {
  getImportDraft,
  linkImportRunToDraft,
  markImportDraftSuperseded,
} from "./importDrafts.js";
import { setImportRunArtifactKeys } from "./importRuns.js";

const t = setupTestDb();

describe("getImportDraft", () => {
  it("returns the row for its own practice and undefined across tenants", async () => {
    const draft = await importDraft(t.db);
    const other = await practice(t.db);

    const found = await getImportDraft(t.db, draft.practiceId, draft.id);
    expect(found?.id).toBe(draft.id);
    expect(found?.status).toBe("confirmed");
    expect(found?.mapping).toEqual(draft.mapping);
    expect(found?.importRunId).toBeNull();

    expect(await getImportDraft(t.db, other.id, draft.id)).toBeUndefined();
  });
});

describe("linkImportRunToDraft / markImportDraftSuperseded", () => {
  it("records the run id and later retires the draft", async () => {
    const draft = await importDraft(t.db);
    const run = await importRun(t.db, { practiceId: draft.practiceId });

    await linkImportRunToDraft(t.db, draft.id, run.id);
    let updated = await getImportDraft(t.db, draft.practiceId, draft.id);
    expect(updated?.importRunId).toBe(run.id);
    expect(updated?.status).toBe("confirmed");

    await markImportDraftSuperseded(t.db, draft.id);
    updated = await getImportDraft(t.db, draft.practiceId, draft.id);
    expect(updated?.status).toBe("superseded");
    // The linkage survives the terminal transition — the report UI (#137)
    // follows it from either side.
    expect(updated?.importRunId).toBe(run.id);
  });
});

describe("setImportRunArtifactKeys", () => {
  it("replaces the run's recorded keys (what dedupe's re-read path consumes)", async () => {
    const run = await importRun(t.db, { rawArtifactKeys: [] });
    const keys = ["p/csv_import/aaa.json", "p/csv_import/bbb.json"];

    await setImportRunArtifactKeys(t.db, run.id, keys);
    expect(await getImportRunArtifactKeys(t.db, run.id)).toEqual(keys);
  });
});
