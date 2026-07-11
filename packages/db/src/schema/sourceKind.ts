/**
 * The `source_kind` Postgres enum, in its own module so both `signals.ts`
 * and `importRuns.ts` can use it without a runtime import cycle (signals
 * references import_runs for its FK; import_runs needs this enum). Values
 * come from `@wellregarded/core` — one source of truth. Re-exported by
 * `signals.ts` (not the barrel) so existing import sites stay unchanged.
 */

import { SOURCE_KINDS } from "@wellregarded/core";
import { pgEnum } from "drizzle-orm/pg-core";

export const sourceKindEnum = pgEnum("source_kind", SOURCE_KINDS);
