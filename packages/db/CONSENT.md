# Consent — the publication gate

Ethical invariant #2: **nothing publishes without an explicit consent
join.**

`isPublishable(db, signalId, channel)` in `src/queries/consents.ts` is the
**single entry point** for publication eligibility. Every publication path —
the Proof API (Epic #14), the proof library (Epic #13), review responses
(Epic #10), GBP placement — MUST call it (or, for proof serving, the
`publishableProofs` helper below). A publication path that does not is a
bug, full stop. See also the "Publication checks" section of
CONTRIBUTING.md.

One sanctioned set-based counterpart exists: `publishableProofs` in
`src/queries/proofs.ts` (issue #96), the canonical query for **serving**
proof. Its consent join encodes the same `checkConsent` rules in SQL —
the patient-partition precedence and version ordering of
`governingConsent`, then each refusal predicate — and is test-locked
against the core function (a property-style check in
`proofs.integration.test.ts` asserts the SQL and JS agree over the same
rows). It is not a second gate — it is the same gate, expressed as a
join. If `checkConsent` changes, that query and its lock-test change in
the same PR.

## The rules it encodes

Eligibility is computed **at read time** from append-only `consents` rows by
the pure `checkConsent` in `@wellregarded/core` (`src/consent/check.ts`):

- Rows are partitioned by `source` first: **`patient_link` always beats the
  staff-side sources** (`practice_attested`, `imported_unknown`). If any
  `patient_link` row exists, the latest `patient_link` row governs and staff
  attestations are ignored — a patient's decision can never be overridden by
  staff, in either direction. Within a partition, the highest
  `consent_version` wins; earlier versions are history, never consulted.
- Publishable iff a governing row exists, `revoked_at IS NULL`, (`expires_at
  IS NULL` or `expires_at > at`, default now), and the channel is in its
  `channels`.
- The decision carries a `reason` (`no_consent | revoked | expired |
  channel_not_granted`) and the governing row, so UIs can explain a refusal
  and callers can apply attribution and minor-edit rules. `checkConsent`
  takes an optional `at` for point-in-time answers ("was this publishable
  when we placed it?").

## What must never exist

There is **no `is_publishable` boolean anywhere in the system** — no
convenience booleans, no cached flags, no `published` column on `signals`.
If a later issue proposes one, that issue is wrong (issue #38 says so
explicitly): a cached flag can disagree with the consent rows, and when it
does we publish something a patient revoked. The guardrail meta-test in
`packages/core/src/consent/guardrail.test.ts` fails CI if the string
appears un-backticked anywhere in `apps/`, `workers/`, or `packages/`.

## Writing consent

`consents` is append-only, with no exceptions (issue #84):

- Granting, narrowing, and re-granting are new rows via `grantConsent`
  (which owns the `consent_version` math — never hand-roll it; the pure
  builder lives in `@wellregarded/core`).
- **Revocation is a new row too**, via `revokeConsent`: a version with
  `revoked_at` set, carrying the *revoker's* `source`. That is what makes
  patient-always-wins hold for revocations — a `patient_link` revocation
  row governs every later staff attestation, and a `practice_attested`
  revocation is recorded but cannot silence a patient's grant. Nothing on
  this table is ever UPDATEd or DELETEd.

## The revocation purge contract (issues #84 → #91, #96)

`revokeConsent` returns `{ revocation, effective, affectedProofIds,
affectedPlacementIds }`:

- `effective` — whether the revocation actually changes what
  `isPublishable` answers (a staff revocation under a governing patient
  grant is recorded but not effective).
- `affectedProofIds` / `affectedPlacementIds` — every proof derived from
  the revoked signal, and those proofs' active placements. The purge
  cascade (issue #91) must purge/deactivate these (placements with
  `deactivation_reason = 'consent_revoked'`); both the staff- and
  patient-initiated paths share this one computation (pure `revokeConsent`
  in `@wellregarded/core`). The ids exist so caches and placements are
  cleaned up promptly — serving decisions still recompute through
  `checkConsent` at read time.
- The lists are computed by `purgeTargetsForSignal` in
  `src/queries/proofs.ts` (the seam issue #96 filled): `{ id, signalId }`
  from `proofs` for the signal, `{ id, proofId }` from its **active**
  `placements` — the structural ref types (`RevocationProofRef`,
  `RevocationPlacementRef` in `@wellregarded/core`) are the contract, and
  the selects run inside the revocation's transaction.
