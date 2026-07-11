/**
 * `SourceAdapter` — the interface every ingestion source implements
 * (issue #101, Epic #6). Google reviews, CSV rows, manual entry, later Open
 * Dental and first-party feedback all converge on `NormalizedSignal` through
 * this interface, and every implementation must pass the shared contract
 * suite (`describeAdapterContract` in `@wellregarded/sources/testing`)
 * before it touches the pipeline.
 */

import type { SourceKind } from "@wellregarded/core";
import type { NormalizedSignal } from "./normalizedSignal.js";

/**
 * What a source can and cannot do. The pipeline and UI branch on these flags
 * instead of switching on `sourceKind`.
 */
export interface SourceAdapterCapabilities {
  /**
   * Can attribute a real patient identity. When `false` the adapter must
   * never emit `patientHint` — the contract suite enforces this.
   */
  supportsIdentity: boolean;
  /**
   * Can carry consent context (`consentHint`). When `false` the adapter must
   * never emit `consentHint` — the contract suite enforces this. Adapters
   * never write `consents` rows either way; mapping is the normalize
   * stage's job.
   */
  supportsConsent: boolean;
  /** Has an incremental fetch story (polling/sync) vs one-shot import. */
  supportsPolling: boolean;
}

export interface SourceAdapter {
  sourceKind: SourceKind;
  /**
   * Turns one parsed raw artifact — exactly as `getRawArtifact` (issue #100)
   * returns it from R2 — into zero or more `NormalizedSignal`s. One artifact
   * may contain a page of many reviews or a CSV batch chunk; a degenerate
   * artifact (empty page/batch) must yield `[]`, never throw.
   *
   * Async even when the implementation is sync — uniform signatures keep the
   * pipeline dispatcher simple.
   */
  normalize(rawArtifact: unknown): Promise<NormalizedSignal[]>;
  capabilities: SourceAdapterCapabilities;
}
