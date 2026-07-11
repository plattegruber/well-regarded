# Eval fixtures — labeled seed corpus for the eval harness (#73)

These files are **eval fodder, not CI tests**. Nothing here runs against a
live model in CI — there is no `ANTHROPIC_API_KEY` in CI by design, and all
automated tests go through `FakeAiProvider`. The eval harness issue
([#73](https://github.com/plattegruber/well-regarded/issues/73)) owns
live-model scoring; this directory exists so it starts non-empty.

## Format

One JSON object per line (`.jsonl`), one file per prompt:

| field | meaning |
|---|---|
| `id` | stable, human-readable case name |
| `prompt` | the prompt version the labels were written against (e.g. `judgments/v1` — see `JUDGMENTS_PROMPT_NAME` in `src/prompts/judgments.ts`) |
| `input` | what the prompt template consumes (for judgments: `{ text, rating }`, mirroring a `signals` row) |
| `expected` | the labeled values per dimension — **raw model expectations**, i.e. before post-processing like `applyUrgencyFloor` |
| `notes` | why the labels are what they are; which failure the case guards against |

## Fixtures

- `fixtures/judgments.jsonl` — the four-judgment classification pass
  (issue #67): a glowing review, an acute-pain complaint (the
  safety-critical case the urgency criteria exist for), and a mixed
  multi-topic review with a third-party name.
- `fixtures/excerpts.jsonl` — the aspect excerpt extraction pass
  (issue #69): expected spans **by offset** (`start_offset` into
  `input.text`; every expected `text` is the verbatim slice at that
  offset — the generator asserted it). A three-aspect review with
  trailing filler, a typo-laden review (verbatim means the typos stay),
  and a single-topic long review that must NOT be over-segmented.

## Adding cases

Prefer realistic, awkward signals over clean ones — the corpus earns its
keep on the boundaries (mixed vs mildly-positive sentiment, medium vs high
urgency, needs_review vs unsuitable). When the prompt changes meaningfully,
bump its version suffix and re-label rather than silently reusing old
labels.
