# ADR 0001: Neon Postgres via Hyperdrive, and React Router v7 on Workers

- **Status:** Accepted
- **Date:** 2026-07-10
- **Deciders:** @plattegruber

Two decisions in one file because they were made together as part of committing to the Cloudflare Workers platform: the database that sits behind the Workers, and the framework the dashboard is served with. Future ADRs default to one decision per file (see [0000-template.md](0000-template.md)).

## Decision 1: Neon Postgres via Hyperdrive, not D1

### Context

Everything runs on Cloudflare Workers, so D1 (Cloudflare's SQLite offering) is the path of least resistance: zero extra vendors, native bindings, no connection pooling to think about. The question is whether SQLite can carry this data model.

It can't, for four reasons that are core to the product rather than incidental:

1. **Relational spine with vector search.** Trust Coverage and dedupe both depend on embeddings, and the architecture deliberately keeps vectors *in the relational database* (pgvector with HNSW indexes) rather than in a separate vector store. D1 has no pgvector equivalent; a separate vector DB would split every consent-aware query across two systems.
2. **Consent joins next to vectors.** The core ethical invariant — nothing publishes without a join through `consents` — has to run *in the same query* that ranks proof excerpts by vector similarity. Proof search is `similarity(embedding) × join(consents)` in one statement. Splitting those across stores would turn the invariant into application-level bookkeeping, which is exactly the failure mode the schema design exists to prevent.
3. **Full-text search.** Hybrid proof search rank-fuses Postgres FTS (tsvector) with vector similarity. D1/SQLite's FTS5 exists but doesn't compose with a vector index in one engine.
4. **Schema-level PII isolation and a BAA.** The HIPAA-shaped boundary is a separate `pii` Postgres schema with app-layer-encrypted contact fields, plus a trigger-enforced append-only `audit_log`. Postgres schemas and triggers are load-bearing here; D1 has neither multiple schemas nor comparable trigger enforcement. And when the first PHI customer arrives, we need a database vendor that signs a BAA — Neon offers that; D1 does not have an established BAA path.

Hyperdrive is Cloudflare's connection pooler/accelerator that makes Postgres usable from Workers (which cannot hold conventional connection pools). Locally, developers connect directly to a docker compose Postgres (`pgvector/pgvector:pg16`), no Hyperdrive involved.

### Decision

We will use Neon Postgres, accessed from Workers via Hyperdrive in deployed environments and via direct connection locally. Drizzle ORM + drizzle-kit for schema and migrations; pgvector (HNSW) for embeddings; Postgres FTS for keyword search.

### Consequences

- Positive: one engine holds the relational spine, the vectors, and the FTS index, so consent-gated hybrid search is a single query and the publication invariant stays schema-enforced. Schema-level PII isolation and trigger-enforced audit append-only work as designed. A BAA is available when PHI arrives.
- Negative: **Hyperdrive adds a network hop** between Worker and database, and **Neon plus Hyperdrive is a paid dependency** where D1 would have been platform-native and effectively free at our scale. Local dev needs docker compose Postgres rather than nothing.
- Neutral: Drizzle abstracts little of this away — engineers write Postgres, and should. If Cloudflare ships a Postgres-compatible product with pgvector and BAA support, revisiting this is a new ADR.

## Decision 2: React Router v7 framework mode on Workers, not Next.js

### Context

The staff dashboard needs a full-stack React framework: server rendering, data loading, and mutations, deployed on Cloudflare Workers alongside everything else. Next.js is the default choice in the ecosystem, but Next.js is built for Vercel's runtime; running it on Workers means going through an adapter layer that lags Next.js releases and reimplements vendor-shaped behavior on a different platform. That impedance is permanent: every Next.js feature has to be asked "does this work on Workers?" first.

React Router v7 in framework mode (the continuation of Remix) treats Cloudflare as a first-class deployment target — Workers deployment is a supported, documented path, not an adapter afterthought — and its loader/action model maps directly onto the Workers request/response runtime with no vendor-runtime impedance.

### Decision

We will build `apps/dashboard` with React Router v7 in framework mode, deployed on Cloudflare Workers, with Tailwind CSS v4 and shadcn/ui for the UI layer.

### Consequences

- Positive: the dashboard deploys like every other worker in the repo — same platform, same wrangler tooling, same CI path. Data loading and mutations use the platform-native request/response model; no adapter to debug when the framework updates.
- Negative: **RR7 framework mode is newer than Next.js** — a smaller ecosystem, fewer worked examples, and hiring familiarity skews toward Next. Some patterns the Next ecosystem hands you (image optimization, ISR-style caching) we assemble from Cloudflare primitives instead.
- Neutral: shadcn/ui and Tailwind are framework-agnostic, so the UI layer would survive a framework change; the loaders/actions would not, and that is the accepted lock-in.
