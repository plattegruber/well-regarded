// Re-exported so Epic #9 (writers) and Epic #11 (readers) can take the
// dimension union from this package alongside the row type; the source of
// truth stays in @wellregarded/core.
export type { DerivationDimension } from "@wellregarded/core";
export { type AuditEntry, audit, type Tx } from "./audit.js";
export { createDb, type Db, type Sql } from "./client.js";
export {
  type PipelineFailureRecord,
  recordPipelineFailure,
} from "./pipeline.js";
export {
  type AiCall,
  createAiCallSink,
  logAiCall,
} from "./queries/aiCalls.js";
export {
  type ApiKey,
  type ResolvedApiKey,
  resolveApiKey,
  touchApiKeyLastUsed,
} from "./queries/apiKeys.js";
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
  insertDerivations,
  type NewDerivation,
  signalHasDerivations,
} from "./queries/derivations.js";
export {
  type HybridSearchParams,
  type HybridSearchResult,
  hybridSearch,
  type ProofExcerpt,
} from "./queries/hybridSearch.js";
export {
  type ContactPoint,
  findContactPoint,
  type Patient,
  type UpsertContactPointInput,
  upsertContactPoint,
} from "./queries/patients.js";
export { getSignal, type Signal } from "./queries/signals.js";
export * as schema from "./schema/index.js";
