# Consent — the publication gate

Ethical invariant #2: **nothing publishes without an explicit consent
join.**

`isPublishable(db, signalId, channel)` in `src/queries/consents.ts` is the
**single entry point** for publication eligibility. Every publication path —
the Proof API (Epic #14), the proof library (Epic #13), review responses
(Epic #10), GBP placement — MUST call it. A publication path that does not
call `isPublishable` is a bug, full stop.

## The rules it encodes

Eligibility is computed **at read time** from append-only `consents` rows by
the pure `evaluateConsent` in `@wellregarded/core` (`src/consent.ts`):

- The row with the highest `consent_version` for the signal is the complete
  current state; earlier versions are history, never consulted.
- Publishable iff that row exists, the channel is in its `channels`,
  `revoked_at IS NULL`, and (`expires_at IS NULL` or `expires_at > now`).
- The decision carries a `reason` (`no_consent | channel_not_granted |
  revoked | expired | ok`) and the winning row, so UIs can explain a refusal
  and callers can apply attribution and minor-edit rules.

## What must never exist

There is **no `is_publishable` boolean anywhere in the system** — no
convenience booleans, no cached flags, no `published` column on `signals`.
If a later issue proposes one, that issue is wrong (issue #38 says so
explicitly): a cached flag can disagree with the consent rows, and when it
does we publish something a patient revoked.

## Writing consent

- Consent versions are never edited. Granting, narrowing, and re-granting
  are all new rows via `grantConsent` (which owns the `consent_version`
  math — never hand-roll it).
- The one permitted UPDATE is `revokeConsent` stamping `revoked_at` on the
  currently-active row. Everything else is an insert.
