// Re-exported so Epic #9 (writers) and Epic #11 (readers) can take the
// dimension union from this package alongside the row type; the source of
// truth stays in @wellregarded/core.
export type { DerivationDimension } from "@wellregarded/core";
export { createDb, type Db, type Sql } from "./client.js";
export {
  type Consent,
  type GrantConsentInput,
  grantConsent,
  isPublishable,
  revokeConsent,
} from "./queries/consents.js";
export {
  type CurrentDerivations,
  type Derivation,
  getCurrentDerivations,
  getCurrentDerivationsForSignals,
} from "./queries/derivations.js";
export * as schema from "./schema/index.js";
