// Drizzle schema barrel.
//
// Remaining domain tables (audit_log, pii.*, embeddings) land in later
// issues of Epic #3 — each adds a module in this directory and re-exports
// it here so `drizzle.config.ts` (schema entry: this barrel) and the typed
// client (`PostgresJsDatabase<typeof schema>`) pick it up.

export * from "./consents.js";
export * from "./derivations.js";
export * from "./signals.js";
export * from "./tenancy.js";
