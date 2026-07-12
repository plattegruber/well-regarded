# Eval harness — golden datasets scored against the live model (#73)

Prompts are code we can't unit-test. Each prompt in `src/prompts/` has a
**golden set** here — 25+ labeled, realistic dental-practice examples —
that `pnpm eval` runs against the **live** model and scores. CI fails on
regression past [`thresholds.json`](thresholds.json), so a prompt tweak
can't silently get worse at the cases that matter.

Two strictly separated layers:

- **`pnpm test` (no API key, runs everywhere):** the pure scoring
  functions (`score.ts`), the runner plumbing (`runner.ts`, tested with
  `FakeAiProvider`), and the fixture labels themselves
  (`fixtures.test.ts`, plus `src/safety.test.ts` which replays every
  safety fixture through the full detector). Nothing here touches the
  network.
- **`pnpm eval` (requires `ANTHROPIC_API_KEY`):** the live run. It
  refuses to start without a key rather than silently faking — a fake
  eval would only measure itself.

## The prompt-change workflow

1. Change a prompt in `src/prompts/` (bump its `*_PROMPT_NAME` version
   suffix if the change is meaningful — labels are written against a
   prompt version, and the fixtures' `prompt` field must be re-labeled to
   match).
2. Run the affected set locally:
   ```sh
   ANTHROPIC_API_KEY=sk-ant-... pnpm eval judgments   # from the repo root
   ```
   Iterating on one failing case? `--only <id>` and `--limit N` keep it
   cheap: `pnpm eval judgments --only sarcasm-surprise-bill`.
3. Review the report the run wrote to
   `reports/<set>-<date>-<model>.md` — aggregate scores, every failing
   case with model output vs expected, and the token cost of the run.
   (Partial `--only`/`--limit` runs are stamped as partial; don't commit
   those as baselines.)
4. Commit the prompt change **and the fresh report together**. A prompt
   PR without an updated report should fail review by convention — the
   report diff is how reviewers see what the change did.
5. CI re-verifies: the [Evals workflow](../../../.github/workflows/evals.yml)
   triggers on any PR touching `packages/ai/src/prompts/**` or
   `packages/ai/evals/**` (and on manual dispatch), re-runs the sets
   against the live model, uploads the reports as an artifact, comments
   them on the PR, and fails the job on any threshold regression.

The model id is part of the report filename on purpose: when
`PIPELINE_MODEL` is upgraded, old reports remain meaningful baselines for
the old model.

### CI and the `ANTHROPIC_API_KEY` secret

The evals job is **not** part of the default PR pipeline (model calls
cost money); the path filter keeps it scoped to prompt/eval changes.
It needs the `ANTHROPIC_API_KEY` **repository secret**. While that secret
is absent (and on fork PRs, which never receive secrets), the job skips
**loudly** — a warning annotation and a step summary saying the prompts
were NOT scored — instead of passing silently. Adding the secret
(Settings → Secrets and variables → Actions) turns on real runs with no
workflow changes.

## Scoring

| set | metric | starting threshold |
|---|---|---|
| judgments | exact-match accuracy per enum dimension | ≥ 0.85 each |
| judgments | **missed-urgent** (expected high/critical scored medium or below) | = 0, zero tolerance |
| judgments | confidence inside the fixture's `confidence_band` (tolerance bands, never exact match) | reported; ungated |
| excerpts | span-F1 — token-overlap precision/recall between expected and produced spans, macro-averaged | mean ≥ 0.75 |
| excerpts | verbatim violations (a produced excerpt that isn't a substring of the original, even after the production retry) | = 0, zero tolerance |
| safety | precision on `block` | ≥ 0.8 |
| safety | recall on `block` | = 1.0 |
| safety | **missed must_block** (a `must_block: true` case scored below block) | = 0, zero tolerance — fails the run regardless of aggregates |

Span-F1 compares token sets within character spans (not exact offsets), so
a valid excerpt that starts one word earlier than the label scores ~1, not
0. The safety set runs the FULL two-layer detector (`checkResponseSafety`)
— deterministic rules plus the live Layer-2 judgment — because that is the
contract the labels describe.

`run.ts` uses the real `AnthropicProvider` from #63, so eval runs also
exercise its retry/validation paths in anger.

## Fixture format

One JSON object per line (`.jsonl` — line-per-case diffs cleanly), one
file per prompt, in `fixtures/`:

| field | meaning |
|---|---|
| `id` | stable, human-readable case name |
| `prompt` | the prompt version the labels were written against (e.g. `judgments/v1` — see `JUDGMENTS_PROMPT_NAME` in `src/prompts/judgments.ts`) |
| `input` | what the prompt template consumes (judgments: `{ text, rating }`; excerpts: `{ text }`; safety: `{ draft, review }`) |
| `expected` | the labeled values (see below) |
| `notes` | why the labels are what they are; which failure the case guards against |

- `fixtures/judgments.jsonl` — the four-judgment classification pass
  (#67). `expected` holds the four enum values as **raw model
  expectations** (before post-processing like `applyUrgencyFloor`), plus
  an optional `confidence_band`: either one inclusive `[low, high]` pair
  applied to all four confidences, or a per-dimension object. Coverage
  includes every urgency tier (post-extraction bleeding and
  pain-three-days-later criticals; discrimination, collections, privacy,
  vulnerable-patient and public-escalation highs), rating-only empty
  text, a very long rambling review, Spanish (labeled identically to the
  English equivalent — the point is that Haiku classifies it instead of
  defaulting to mixed/low-confidence), sarcasm, positive-care/negative-
  billing, profanity, incoherence, and the borderline third-party-name
  publication call.
- `fixtures/excerpts.jsonl` — aspect excerpt extraction (#69). Expected
  spans **by offset**: every `text` is the verbatim slice at
  `start_offset` (enforced by `fixtures.test.ts` — never hand-compute an
  offset; the appends were generated). Coverage: 1–4 aspect reviews,
  filler traps, typo and smart-punctuation preservation, Spanish,
  sarcasm, list format, run-ons, and long single-topic reviews that must
  not be over-segmented.
- `fixtures/safety.jsonl` — the privacy-disclosure detector (#72).
  `expected.level` is the verdict of the FULL two-layer detector;
  `must_block: true` marks the zero-tolerance cases. The set holds the
  issue's labeled replies plus near-misses on each deterministic rule
  (bare weekday plurals, order-of-magnitude dollar phrases, phone-only
  warns) and LLM-only cases ("part of our dental family for five
  years"). The same fixtures replay in `src/safety.test.ts` with
  `FakeAiProvider` supplying the Layer-2 judgments.

### Adding cases

Prefer realistic, awkward signals over clean ones — the corpus earns its
keep on the boundaries (mixed vs mildly-positive sentiment, medium vs
high urgency, needs_review vs unsuitable). Keep `notes` honest about why
a label is right. When a prompt changes meaningfully, bump its version
suffix and re-label rather than silently reusing old labels. New safety
cases whose expected level depends on the LLM layer also need a canned
judgment in `src/safety.test.ts`'s `llmJudgments` map.

## Files

```
evals/
  fixtures/            # the golden sets (JSONL, one per prompt)
  reports/             # committed run reports: <set>-<date>-<model>.md
  cases.ts             # fixture schemas + loading
  score.ts             # pure scoring functions (unit-tested, no API)
  runner.ts            # provider-driven plumbing (tested with FakeAiProvider)
  run.ts               # the `pnpm eval` CLI (live model, requires API key)
  thresholds.json      # regression gates
```
