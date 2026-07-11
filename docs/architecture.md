# Architecture

This is the map of Well-Regarded: what the system does, the stack it is built on, the tables everything hangs off, and the pipeline that feeds them. It is a map, not the territory — runbooks and deep dives get their own files under `docs/` as they are written. Decisions with real alternatives are recorded in [docs/adr/](adr/).

Much of what this document describes is decided but not yet built. The repo today is the monorepo scaffold from [#26](https://github.com/plattegruber/well-regarded/issues/26); anything not in the tree yet is marked **planned** with the issue or epic that delivers it. When code and this document disagree, one of them is a bug — fix whichever is wrong.

## Product overview

Patient-experience signals are scattered across sources — Google reviews, CSV exports from other reputation vendors, manual entry, and later first-party post-visit feedback — and practices lack credible, permissioned proof of the trust they have earned.

Well-Regarded ingests signals from any legitimate source, normalizes them into a canonical **Trust Signal**, classifies them with AI (sentiment, urgency, response risk, publication suitability — stored as **derivations** with confidence and basis), routes concerns into **recovery** workflows, manages **consent and rights** for republication, and serves permissioned **proof** through a public search API that practices embed on their websites. **Trust Coverage** computes where a practice lacks credible evidence, geometrically: demand-side embeddings (what patients search for) against supply-side proof embeddings (what the practice can show).

Two ethical invariants are structural rather than aspirational — they get their own section [below](#ethical-invariants), because they are enforced by the schema, not by policy.

## Stack

Decided; the reasoning for the two decisions with serious alternatives is in [ADR 0001](adr/0001-postgres-hyperdrive-and-react-router.md).

- **Platform:** Cloudflare Workers everywhere. Hono for API workers. Cloudflare Queues for pipeline stages, Cloudflare Workflows for durable multi-step processes (imports, message sequences, escalation timers), Cron Triggers for polling, R2 for raw import artifacts and media, KV for proof-API cache and config, Durable Objects for per-integration sync locks.
- **Dashboard:** React Router v7 (framework mode) deployed on Workers. Tailwind CSS v4 + shadcn/ui.
- **Auth:** Clerk. A Clerk Organization *is* a practice. Locations, providers, and permissions live in our DB, not Clerk. Patients never get Clerk accounts — they get signed, single-purpose, expiring tokens embedded in links.
- **Database:** Neon Postgres via Hyperdrive (direct connection locally). Drizzle ORM + drizzle-kit migrations. pgvector for embeddings (HNSW indexes). Postgres FTS for keyword search; hybrid search = vector + FTS, rank-fused.
- **AI:** Claude API — `claude-haiku-4-5-20251001` for high-volume pipeline classification, `claude-sonnet-5` for Trust Brief narrative and response drafting. Structured outputs validated with zod. Embeddings: Workers AI `@cf/baai/bge-m3` (swappable; the vectors live in pgvector, not in a vendor store).
- **Messaging (M4):** Twilio SMS and AWS SES email — both BAA-capable. Outbound messages are PHI-free by design: practice name plus a tokenized link, nothing else.
- **PMS integration (M4):** Open Dental REST API, behind an internal `AppointmentEventSource` interface so an aggregator can be swapped in later without touching consumers.
- **Tooling:** pnpm workspaces + Turborepo. TypeScript strict. Vitest (unit + integration), Playwright (E2E). Biome for lint/format (planned: [#27](https://github.com/plattegruber/well-regarded/issues/27)). GitHub Actions CI/CD via `wrangler-action` (planned: Epic [#2](https://github.com/plattegruber/well-regarded/issues/2)). Local Postgres via docker compose using the `pgvector/pgvector:pg16` image (planned: [#29](https://github.com/plattegruber/well-regarded/issues/29)). `wrangler dev` + Miniflare for local Workers, Queues, KV, and R2 (planned: [#28](https://github.com/plattegruber/well-regarded/issues/28)).

## Monorepo layout

See the [repository layout table in the README](../README.md#repository-layout) — that table is the single source of truth for workspace paths and purposes. In short: `apps/*` are the two frontends (staff dashboard, tokenized patient pages), `workers/*` are the three Cloudflare Workers (API, pipeline queue consumers, workflows/cron), and `packages/*` hold the shared spine (`db`, `core`, `ai`, `sources`).

## Data model spine

Planned: Epic [#3](https://github.com/plattegruber/well-regarded/issues/3) builds these tables in `packages/db` (Drizzle schema + migrations). The vocabulary below is canonical — issues, code, and reviews all use these exact table names.

The load-bearing idea: **facts and judgments live in different tables.** A `signals` row is the immutable record of what happened — original content plus provenance, never edited. Every judgment *about* a signal (its sentiment, its urgency, whether it is suitable for publication) is a row in `derivations`, tagged with how we know and how sure we are. Reclassifying a signal means writing new derivation rows, never rewriting history.

### Tenancy

`practices`, `locations`, `providers`, `staff_members`. A `practice_id` appears on everything, and every query is practice-scoped. There is no cross-practice read path.

### Signals and judgments

- `signals` — the canonical Trust Signal. Immutable original content plus provenance: `source_kind`, `source_id`, `source_url`, `occurred_at`, `visibility` (public | private), `original_rating`, `import_run_id`, `availability` (available | deleted_at_source), plus nullable `patient_id`, `location_id`, `provider_id`.
- `derivations` — one row per judgment: `(signal_id, dimension, value, confidence, basis, model_version, created_at)`. `basis` is one of `source_metadata | manual | inferred_text | inferred_related`. Dimensions: sentiment, urgency, response_risk, publication_suitability. Topics are deliberately **not** enumerated dimensions — topics are emergent, discovered via embeddings and clustering, so the taxonomy can follow the data instead of constraining it.
- `proof_excerpts` — aspect-level excerpts extracted from signals, each with its own embedding (vector column) and tsvector. A multi-topic review is split into excerpts; each excerpt links back to its parent signal, so provenance survives the split.

### Consent and publication

- `consents` — append-only versions: scope (channels), attribution rules, edit permission, granted/revoked, source of consent, `consent_version`. Publication eligibility is always a join through this table. Revocation is a new version, not a deletion — the history of what was permitted when is itself evidence.

### Operations

- `recovery_items` — the concern workflow: severity, owner, due date, contact log, resolution, escalation state.
- `responses` — public review responses with a state machine: draft → pending_approval → approved → published, plus failure states.
- `import_runs` — provenance for every batch or poll: source, counts (created/merged/skipped/failed), and the R2 key of the raw artifact. If something went in, this table knows about it; if something failed, this table shows it.
- `messages` — outbound SMS/email with delivery state, suppression checks, and template ref.

### Audit and PII

- `audit_log` — append-only, and not by convention: a Postgres trigger blocks UPDATE and DELETE. Records actor, action, entity, before/after refs. Every consent change, publication, approval, patient-data access, and deletion writes here.
- `pii.patients`, `pii.contact_points` — a **separate Postgres schema**, with phone/email encrypted at the application layer (AES-GCM, keys in Worker secrets). This is the HIPAA-shaped boundary: the shape is built now, so signing BAAs at the first PHI customer is a paperwork event, not a re-architecture. Nothing outside the `pii` schema stores contact details, and code outside the PII access layer never sees plaintext.

## Ingestion pipeline

Planned: Epic [#6](https://github.com/plattegruber/well-regarded/issues/6) builds this in `workers/pipeline` and `packages/sources`. The canonical stage names:

```
source adapter → raw payload to R2 → queue:ingest (normalize) → queue:dedupe → queue:classify → queue:route
```

1. **Source adapter** (`packages/sources`) — each source (google, csv, manual, opendental, firstparty) implements the `SourceAdapter` contract and emits `NormalizedSignal` candidates.
2. **Raw payload to R2** — the untouched original artifact is stored first, content-addressed, before any processing. Whatever the pipeline does downstream, the original is recoverable.
3. **`queue:ingest` (normalize)** — map source-shaped payloads into canonical `signals` rows.
4. **`queue:dedupe`** — exact-hash matching plus embedding-based fuzzy candidates. No silent merges: a merge is a recorded decision.
5. **`queue:classify`** — AI classification via `packages/ai`, writing `derivations` rows (haiku-tier model, zod-validated structured output).
6. **`queue:route`** — outcomes: high urgency → `recovery_items`; public review → the review inbox; publishable candidate → a proof suggestion (which is consent-gated before it can ever serve).

Failures go to per-queue DLQs and **must be visible in `import_runs` — never silent.** A batch that partially failed says so in its counts; an operator can always answer "what happened to my import?" from the dashboard.

## Ethical invariants

These are architecture, not values statements — each is enforced by schema shape, so violating it requires changing the schema in a reviewable way, not just skipping a check.

1. **An AI inference is never presented as confirmed fact.** Every `derivations` row carries `basis` and `confidence`. There is no way to store a judgment without declaring how it was reached, and UIs render inferred values as inferences.
2. **Nothing publishes without an explicit consent join.** Publication checks go through the `consents` table — a join against an append-only, versioned record. There is no `is_publishable` boolean anywhere, so there is no flag to flip by accident, by bug, or by shortcut.

Related structural rules from the [roadmap (#164)](https://github.com/plattegruber/well-regarded/issues/164) that follow the same enforce-by-shape philosophy: `audit_log` is trigger-enforced append-only; PII lives only in the `pii.*` schema with encrypted contact fields; the pipeline has no silent failure path (`import_runs` sees everything); every eligible patient gets the same review opportunity — sentiment never gates invitations, structurally: the invite page cannot see sentiment; and outbound messages are PHI-free by construction via a template variable whitelist.

## Environments and bindings

Planned: [#28](https://github.com/plattegruber/well-regarded/issues/28) adds per-worker wrangler configs and the local/preview/prod environment matrix under `infra/` (including `infra/environments.md`, which this section will link to once it exists). Secrets conventions and zod-validated environment configuration land with [#30](https://github.com/plattegruber/well-regarded/issues/30). Until then, the only environment is local, and the [README Quickstart](../README.md#quickstart) is the complete setup story.
