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
  canonicalPair,
  type DuplicateCandidate,
  type FindDuplicateCandidatesParams,
  findDuplicateCandidates,
  getImportRunArtifactKeys,
  getSignalWithCurrentContent,
  insertSuspectedDuplicates,
  listSuspectedDuplicatesForPractice,
  type RecordSignalVersionInput,
  type ResolveSuspectedDuplicateInput,
  recordSignalVersion,
  resolveSuspectedDuplicate,
  type SignalVersion,
  type SignalWithCurrentContent,
  type SuspectedDuplicate,
  type SuspectedDuplicateLink,
  setSignalPipelineStatus,
  updateSignalEmbedding,
} from "./queries/dedupe.js";
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
  appendImportRunError,
  type CreateImportRunInput,
  createImportRun,
  finalizeImportRun,
  getImportRunSummary,
  type ImportRun,
  type ImportRunCountDelta,
  type ImportRunPage,
  type ImportRunSummary,
  incrementImportRunCounts,
  type ListImportRunsOptions,
  listImportRuns,
} from "./queries/importRuns.js";
export {
  type ContactPoint,
  findContactPoint,
  matchOrCreatePatientByContact,
  type Patient,
  type PatientContactHint,
  type UpsertContactPointInput,
  upsertContactPoint,
} from "./queries/patients.js";
export {
  type ExcerptNeedingEmbedding,
  type ExcerptsNeedingEmbeddingParams,
  excerptsNeedingEmbedding,
  insertProofExcerpts,
  type NewProofExcerpt,
  type ProofExcerptEmbeddingUpdate,
  setProofExcerptEmbeddings,
  signalHasProofExcerpts,
} from "./queries/proofExcerpts.js";
export {
  getSignal,
  insertNormalizedSignals,
  type NormalizedSignalOutcome,
  type Signal,
  type SignalInsert,
} from "./queries/signals.js";
export {
  decodeSignalsCursor,
  type GetSignalDetailParams,
  getSignalDetail,
  type ListSignalsParams,
  listSignalFilterOptions,
  listSignals,
  SIGNALS_PAGE_SIZE,
  type SignalDetail,
  type SignalDetailDuplicate,
  type SignalDetailExcerpt,
  type SignalFilterOptions,
  type SignalListFilters,
  type SignalListItem,
  type SignalListJudgment,
  type SignalListPage,
  type SignalListPatient,
  type SignalViewerPermissions,
} from "./queries/signalsInbox.js";
export {
  disconnectSourceConnection,
  getSourceConnection,
  markSourceConnectionNeedsReauth,
  type SourceConnection,
  type UpsertSourceConnectionInput,
  upsertSourceConnection,
} from "./queries/sourceConnections.js";
export {
  getPracticeByClerkOrgId,
  getStaffMemberByRole,
  type Practice,
  type StaffMember,
} from "./queries/tenancy.js";
export * as schema from "./schema/index.js";
