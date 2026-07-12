/**
 * Consent domain logic (issues #38 and #84, Epics #3 and #12) — the single
 * place where "may this be published?" is answered.
 *
 * Pure functions only: no DB, no network. Callers fetch a signal's
 * `consents` rows; these functions decide. The effectful wrappers live in
 * `@wellregarded/db` (`isPublishable`, `grantConsent`, `revokeConsent` in
 * `src/queries/consents.ts`) — see `packages/db/CONSENT.md`.
 */

export * from "./check.js";
export * from "./grant.js";
export * from "./model.js";
export * from "./revoke.js";
