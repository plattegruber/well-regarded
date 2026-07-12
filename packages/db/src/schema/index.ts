// Drizzle schema barrel.
//
// Every schema module in this directory is re-exported here so
// `drizzle.config.ts` (schema entry: this barrel) and the typed client
// (`PostgresJsDatabase<typeof schema>`) pick it up.

export * from "./aiCalls.js";
export * from "./apiKeys.js";
export * from "./audit.js";
export * from "./consents.js";
export * from "./dedupe.js";
export * from "./derivations.js";
export * from "./importDrafts.js";
export * from "./importRuns.js";
export * from "./pii.js";
export * from "./practiceSettings.js";
export * from "./proofExcerpts.js";
export * from "./responses.js";
export * from "./signals.js";
export * from "./sourceConnections.js";
export * from "./tenancy.js";
