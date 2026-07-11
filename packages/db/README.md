# @wellregarded/db

Drizzle ORM schema, migrations, and connection management for Well Regarded.

Works in both runtimes we care about, with the same driver (postgres-js):

- **Cloudflare Workers** — Neon Postgres via a Hyperdrive binding
- **Node (local dev / CI)** — direct connection to the docker compose Postgres

## Usage

```ts
import { createDb } from "@wellregarded/db";

// Workers: create per-request, pass the Hyperdrive connection string.
const { db, sql } = createDb(env.HYPERDRIVE.connectionString);

// Node (local/CI): pass DATABASE_URL yourself — the factory never reads
// globals (env validation lives in @wellregarded/core).
const { db, sql } = createDb(process.env.DATABASE_URL);
```

- `db` is the typed Drizzle client (`PostgresJsDatabase<typeof schema>`).
- `sql` is the raw postgres-js client, exposed for hand-written queries
  (the hybrid-search helper later in Epic #3 needs it).

## Migration workflow

Commands (run from the repo root; `db:migrate` and `db:studio` read
`DATABASE_URL` from the environment):

| Command | What it does |
| --- | --- |
| `pnpm db:generate` | Diff `src/schema/*.ts` against the last snapshot and emit SQL into `migrations/` |
| `pnpm db:migrate` | Apply pending migrations from `migrations/` to `DATABASE_URL` |
| `pnpm db:studio` | Open Drizzle Studio against `DATABASE_URL` |

Local dev: `docker compose up -d && pnpm db:migrate` (idempotent — re-running
is a no-op).

### Conventions

- **Migrations are append-only.** Never edit or delete a checked-in
  migration; fix-forward with a new one. Drizzle records applied migrations
  by hash — editing an applied file breaks every existing database.
- **Schema and migrations must agree.** Every change under `src/schema`
  ships with the migration `pnpm db:generate` emits for it, in the same PR —
  including the `meta/` journal and snapshot updates it writes alongside.
- **Generated SQL is reviewed like source code** before merge. `db:generate`
  output is a starting point, not a finished artifact.
- **Hand-written SQL migrations are expected** for anything the schema DSL
  can't express (extensions, triggers, generated columns). Use
  `pnpm db:generate --custom --name <name>` to create an empty journal entry,
  then write the SQL by hand. Migration
  `0001_enable_pgvector_and_pii_schema` (pgvector + the `pii` schema) is the
  template.

### CI enforcement (the migration gate)

CI's `migration-check` job
([#55](https://github.com/plattegruber/well-regarded/issues/55), see
`.github/workflows/ci.yml`) enforces both conventions on every PR:

- **Drift check** — re-runs `drizzle-kit generate` and fails if it produces
  any change: "schema changed without a migration". Fix by running
  `pnpm db:generate` and committing everything it wrote.
- **Append-only check** — fails if any `*.sql` file under `migrations/` that
  exists on `origin/main` was modified, deleted, or renamed (diffed against
  the merge-base, so migrations that land on `main` while your PR is open
  are never flagged as edits). Fix by reverting and writing a new migration.

The scoping is deliberate: `meta/_journal.json` and `meta/*_snapshot.json`
are *not* covered by the append-only rule, because `generate` legitimately
rewrites the journal (and adds a snapshot) whenever a new migration is
appended. Their integrity is covered by the drift check instead — `generate`
is deterministic given schema + journal + drizzle-kit version, so a
hand-edited journal or snapshot makes the regeneration diff non-empty.

There is **no override**. A merged migration that turns out to be broken is
fixed by a new corrective migration, never by editing the old file.

### Tooling boundary

`drizzle-kit` runs in Node only and is a dev/CI tool. It lives in
`devDependencies` and **must never be imported by Worker code** — nothing
under `src/` may import it, so it is never bundled.

## PII & field encryption

Patient identity lives in the isolated `pii` Postgres schema
(`pii.patients`, `pii.contact_points` — see `src/schema/pii.ts`), and
contact values are encrypted at the application layer (AES-256-GCM via
WebCrypto, `encryptField` in `@wellregarded/core`) before they reach the
database. A deterministic HMAC (`value_hash`) makes encrypted values
findable by equality without decryption.

**The rule: nothing outside `packages/db` and `packages/core` touches
`value_encrypted` or the keyring.** Reads and writes go through
`findContactPoint` / `upsertContactPoint` in `src/queries/patients.ts`
(hash lookup, encrypt-on-write — never decrypt-to-search). API responses
that include contact info decrypt explicitly at the edge with
`decryptField`, and every such access is audited via `audit()` with action
`patient.viewed`.

Key handling (see `docs/secrets.md` for the variable table):

- `PII_ENCRYPTION_KEYS` — JSON map of version → base64 32-byte AES key,
  e.g. `{ "1": "<openssl rand -base64 32>" }`. The highest version
  encrypts new writes; every version that still has rows must remain
  present. Rotation = add `"2"` and keep `"1"`.
- `PII_HASH_KEY` — base64 32 bytes, separate from the encryption keys.
  Never rotate it casually: rotating orphans every stored `value_hash`.
- Generate keys with `openssl rand -base64 32`. Dev placeholders live in
  the workers' `.dev.vars.example`; never commit real keys.

## Audit log

`audit_log` is append-only, enforced by the database (the
`audit_log_block_mutation` trigger rejects UPDATE and DELETE; TRUNCATE is
revoked from PUBLIC). Every mutation path calls `audit()` from
`src/audit.ts` **inside the same transaction as the change it records** —
an audit row cannot exist without its mutation, or the mutation without
its audit row.

## Hyperdrive caveats

The connection defaults in `createDb` exist because of how Hyperdrive pools
connections. Don't "fix" them without reading this:

- **Keep the client-side pool small (`max: 5`) and create the client
  per-request in Workers.** Hyperdrive pools connections upstream; isolates
  cannot reliably share sockets across requests, and Hyperdrive makes
  reconnects cheap. A big client-side pool just hoards pooled backends.
- **`prepare: false`, everywhere.** Named prepared statements bind to a
  specific pooled backend connection and break in confusing ways under
  transaction-mode pooling. We leave them off in Node too, so local and prod
  behave identically.
- **Keep transactions short.** A long-lived transaction holds a pooled
  connection hostage for its whole duration. The audit + mutation patterns
  later in Epic #3 assume short transactions.

Reference: [Drizzle + Cloudflare Workers / Hyperdrive](https://orm.drizzle.team/docs/connect-cloudflare-workers)
(we follow the postgres-js variant, not neon-http).

## Testing

- Unit tests run anywhere: `pnpm --filter @wellregarded/db test`.
- Integration tests (`src/client.integration.test.ts`) run only when
  `DATABASE_URL` is set and expect migrations to have been applied:

  ```sh
  docker compose up -d && pnpm db:migrate
  DATABASE_URL=postgres://... pnpm --filter @wellregarded/db test
  ```

  The per-test isolation harness is a separate issue in Epic #3; until it
  lands, integration tests hit the shared local database directly.
