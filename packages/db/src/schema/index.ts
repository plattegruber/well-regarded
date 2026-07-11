// Drizzle schema barrel.
//
// Domain tables (tenancy, signals, derivations, consents, audit_log, pii.*)
// land in later issues of Epic #3 — each adds a module in this directory and
// re-exports it here so `drizzle.config.ts` (schema glob `./src/schema/*.ts`)
// and the typed client (`PostgresJsDatabase<typeof schema>`) pick it up.

export {};
