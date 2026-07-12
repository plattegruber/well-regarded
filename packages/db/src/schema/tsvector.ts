/**
 * Postgres `tsvector`, which drizzle-orm has no built-in column type for.
 * Only ever read/written by Postgres itself (stored generated columns + GIN
 * indexes); the string data type exists for row-type completeness. Shared
 * by `proof_excerpts.tsv` (issue #48) and `signals.tsv` (issue #88).
 */

import { customType } from "drizzle-orm/pg-core";

export const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});
