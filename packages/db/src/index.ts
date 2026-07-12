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
  monthlyAiSpendCents,
  type PracticeAiStatus,
  practiceAiStatus,
} from "./queries/aiBudget.js";
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
  type ImportRunDuplicate,
  type ImportRunDuplicateSignal,
  insertSuspectedDuplicates,
  listSuspectedDuplicatesForImportRun,
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
  type GoogleMappingDecision,
  type GoogleMappingEntry,
  type GoogleMappingIssue,
  type GoogleMappingIssueCode,
  type SaveGoogleLocationMappingsInput,
  type SaveGoogleLocationMappingsResult,
  saveGoogleLocationMappings,
} from "./queries/googleLocationMappings.js";
export {
  type HybridSearchParams,
  type HybridSearchResult,
  hybridSearch,
  type ProofExcerpt,
} from "./queries/hybridSearch.js";
export {
  type ConfirmImportDraftResult,
  confirmImportDraft,
  getImportDraft,
  type ImportDraft,
  linkImportRunToDraft,
  markImportDraftSuperseded,
  type SaveImportDraftConsentResult,
  type SaveImportDraftMappingResult,
  saveImportDraftConsent,
  saveImportDraftMapping,
  setImportDraftWizardStep,
} from "./queries/importDrafts.js";
export {
  appendImportRunError,
  type CreateImportRunInput,
  createImportRun,
  finalizeImportRun,
  finalizeImportRunWithStatus,
  getImportRunDraftInfo,
  getImportRunSummary,
  type ImportRun,
  type ImportRunCountDelta,
  type ImportRunDraftInfo,
  type ImportRunPage,
  type ImportRunSummary,
  incrementImportRunCounts,
  type ListImportRunsOptions,
  listImportRuns,
  setImportRunArtifactKeys,
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
  getPracticeAiSettings,
  type PracticeSettings,
  type UpdatePracticeAiSettingsInput,
  updatePracticeAiSettings,
} from "./queries/practiceSettings.js";
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
  type ConfirmDerivationInput,
  confirmDerivation,
  type ReclassifyDerivationInput,
  reclassifyDerivation,
  type SetSignalAssociationInput,
  type SignalAssociationKind,
  setSignalAssociation,
} from "./queries/reclassify.js";
export {
  auditPublishAttempt,
  type CreateResponseDraftInput,
  countPendingApprovals,
  createResponseDraft,
  type FailedPublish,
  getResponse,
  getResponseReviewContext,
  listFailedPublishes,
  listResponsesForSignal,
  listResponsesPendingApproval,
  type PendingApprovalCard,
  type ResponsePublishPatch,
  type ResponseReviewContext,
  type ResponseThreadRow,
  type ReviewResponse,
  type TransitionResponseInput,
  type TransitionResponseResult,
  transitionResponse,
  type UpsertImportedResponseInput,
  type UpsertImportedResponseOutcome,
  type UpsertImportedResponseResult,
  upsertImportedResponse,
} from "./queries/responses.js";
export {
  type LocationMetrics,
  METRICS_MONTHS,
  METRICS_SMALL_SAMPLE,
  type MonthMetrics,
  type ReviewResponseMetrics,
  reviewResponseMetrics,
} from "./queries/reviewResponseMetrics.js";
export {
  countReviewInboxStatuses,
  decodeReviewsCursor,
  getReviewDetail,
  type ListReviewInboxParams,
  listReviewInbox,
  REVIEWS_PAGE_SIZE,
  type ReviewDetail,
  type ReviewInboxCounts,
  type ReviewInboxFilters,
  type ReviewInboxItem,
  type ReviewInboxPage,
  type ReviewInboxSort,
  type ReviewResponseThreadEntry,
} from "./queries/reviewsInbox.js";
export {
  clearClassificationDeferred,
  getSignal,
  googleSignalsForReplyImport,
  insertNormalizedSignals,
  listDeferredClassifications,
  markClassificationDeferred,
  type NormalizedSignalOutcome,
  type ReplyImportCandidate,
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
  getSourceConnectionById,
  listActiveSourceConnections,
  markSourceConnectionNeedsReauth,
  patchSourceConnectionMetadata,
  type SourceConnection,
  setSourceConnectionLastSyncAt,
  type UpsertSourceConnectionInput,
  upsertSourceConnection,
} from "./queries/sourceConnections.js";
export {
  getPracticeByClerkOrgId,
  getStaffMemberByRole,
  type Location,
  listPracticeLocations,
  type Practice,
  type StaffMember,
} from "./queries/tenancy.js";
export {
  listFailedImports,
  listNegativeReviewsNeedingResponse,
  listReauthConnections,
  listRunningImports,
  listUrgentSignals,
  type NegativeReviewCard,
  TODAY_SECTION_LIMIT,
  type TodaySection,
  type UrgentSignalCard,
} from "./queries/today.js";
export * as schema from "./schema/index.js";
