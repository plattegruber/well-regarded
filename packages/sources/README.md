# @wellregarded/sources

The source-adapter foundation for the ingestion pipeline (Epic #6): R2
raw-artifact storage (issue #100) and the `SourceAdapter` / `NormalizedSignal`
contracts with their shared contract-test suite (issue #101). Every ingestion
source — Google reviews, CSV imports, manual entry, later Open Dental and
first-party feedback — flows through this package.

Three entry points:

- `@wellregarded/sources` — Workers-runtime clean (Web Crypto + zod only).
  Safe to import from any worker.
- `@wellregarded/sources/testing` — the contract suite
  (`describeAdapterContract`), the test-only reference adapter, and the
  in-memory bucket fake. Imports `vitest`; **test files only, never worker
  code**.
- `@wellregarded/sources/google/fake` — the fake Google Business Profile
  server (issue #130): a Hono app + mutable store for every Epic #7 test,
  also runnable standalone (`pnpm dev:fake-gbp`). Dev/test only, never
  deployed; see [`src/google/fake/README.md`](src/google/fake/README.md)
  for the fidelity contract.

## Raw artifacts (issue #100)

### Store-before-enqueue — the rule everything else hangs off

**Nothing enters a pipeline queue unless its raw artifact is already durable
in R2.** Callers `await putRawArtifact(...)` first and carry the returned key
in the queue message:

```ts
import { putRawArtifact } from "@wellregarded/sources";

const { key } = await putRawArtifact(env.RAW_ARTIFACTS_BUCKET, {
  practiceId,
  sourceKind: "google",
  content: JSON.stringify(page), // serialize ONCE; the key hashes these bytes
});
// only now may `key` be enqueued in an ingest message
```

The pipeline treats a missing artifact as a hard failure — `getRawArtifact`
throws a typed `ArtifactNotFoundError` that consumers must send to the DLQ,
never retry-until-timeout. Under store-before-enqueue an enqueued key always
exists, so a miss is a contract violation worth failing loudly over.

### Content-addressed keys and immutability

Keys are `{practiceId}/{sourceKind}/{sha256(content)}.json`, hashed over the
exact bytes written. Same content ⇒ same key ⇒ puts are naturally idempotent,
and writing *different* content to an existing key is impossible by
construction — that is the reason for the scheme. Artifacts are never
overwritten or mutated; `putRawArtifact` skips the write when the key already
exists (idempotent re-import).

The CSV import (Epic #8) reuses `putRawArtifact` unchanged — the
practice-scoped scheme applies as-is, no special-casing.

### Retention: indefinite, on purpose

Raw artifacts are the provenance record backing `import_runs`, dedupe,
re-normalization after adapter bugs, and the audit story. They are kept
**indefinitely**. Do not add a lifecycle/expiry policy to this bucket —
"cleaning up" old artifacts destroys the ability to re-derive and audit
historical signals.

### Bucket naming and bindings (reconciliation note)

Reconciled in #104: `RAW_ARTIFACTS` → `wr-raw-artifacts-<env>` is its own
bucket, bound in `workers/pipeline` (the normalize stage reads artifacts
from it) and listed in `docs/architecture-bindings.md`. The `RAW_IMPORTS`
bucket (`workers/api`, #170) remains separate — raw *uploaded files* before
adapter processing, vs. the content-addressed artifacts here. `workers/api`
and `workers/jobs` gain the `RAW_ARTIFACTS` binding when their producers
start calling `putRawArtifact` (Epics #7/#8).

The helpers here are deliberately **binding-name agnostic**: they take an
injected `RawArtifactBucket` (a structural subset of `R2Bucket`, so
`env.<WHATEVER_BINDING>` passes straight in and the helpers stay
unit-testable against `InMemoryRawArtifactBucket`). No code in this package
hardcodes a bucket or binding name, so the reconciliation is a wrangler-config
and docs decision, not a code change here. Locally, Miniflare simulates R2
under `wrangler dev` with persistence in `.wrangler/state` — no extra setup.

Per the env-schema ownership split in `packages/core/src/env.ts`, R2 bindings
are typed by the `wrangler types`-generated `Env` interface, not by the zod
env schemas — so there is no zod entry to add for the bucket.

## Writing a source adapter (issue #101)

An adapter is a `SourceAdapter`: a `sourceKind`, capability flags
(`supportsIdentity`, `supportsConsent`, `supportsPolling`), and one method —
`normalize(rawArtifact) => Promise<NormalizedSignal[]>` — that turns a parsed
raw artifact (exactly as `getRawArtifact` returns it) into zero or more
`NormalizedSignal`s.

Ground rules the schema and contract suite enforce:

- **Strict shape.** `normalizedSignalSchema` is `z.strictObject` throughout;
  unknown keys fail loudly instead of silently dropping data.
- **Stable `sourceId`s.** Normalizing the same artifact twice must yield the
  same IDs — dedupe depends on it.
- **Ratings stay on the source's scale** (`{ value, scale }`). Converting to
  a canonical scale is normalize-stage policy (#104), and CSV scale detection
  is Epic #8's job.
- **Hints, not FK guesses.** `providerHint`/`locationHint` are
  `{ text, basis }` with the standard basis vocabulary
  (`source_metadata` | `manual` | `inferred_text` | `inferred_related` — the
  same `DERIVATION_BASES` as `derivations`). Entity resolution is #104's job.
- **`patientHint` only if `supportsIdentity`** — destined for the `pii.*`
  boundary downstream, never stored on `signals` directly.
- **`consentHint` only if `supportsConsent`**
  (`practice_attested` | `imported_unknown`); adapters never write
  `consents` rows.
- **Degenerate inputs yield `[]`**, never throw (empty page, empty batch).

Every adapter's test file must run the shared contract suite with
recorded-shape fixtures:

```ts
import { describeAdapterContract } from "@wellregarded/sources/testing";
import { myAdapter } from "./myAdapter.js";

describeAdapterContract(myAdapter, {
  valid: [
    { name: "one page of reviews", artifact: recordedPage, expectedCount: 3 },
  ],
  empty: recordedEmptyPage,
});
```

Add source-specific assertions in the same file; the suite covers only the
cross-source invariants. `src/contract/fixtureAdapter.ts` is the test-only
reference implementation that keeps the suite exercised in this package's CI
— it is *not* the manual-entry adapter (that ships with issue #138, Epic #8).

`NormalizedSignal` mirrors — deliberately does not import — the
source-independent columns of the `signals` table;
`src/contract/signalsTableDrift.test.ts` pins the mapping so schema drift
fails `pnpm typecheck` instead of surfacing in production.
