# Design assets

## Provenance

Imported from the Claude Design project **"Well Regarded dashboard build"**
(id `a77fef54-60c0-45b8-a56e-463a6ea6af03`) on 2026-07-11 via DesignSync.
The mockup's asset paths were rewritten to be repo-relative (`design-system/...`)
so the file renders from this directory without the Claude Design host.

The design-system readme's INDEX references directories (`guidelines/`,
`components/`, `ui_kits/`) that exist in the Claude Design project's fuller
system but were not part of this project's file set. The component JSX sources
**are** recoverable, though: `design-system/_ds_bundle.js` embeds each
component's source (marked with `// components/<group>/<Name>.jsx` comments and
listed in its `@ds-bundle` header), and `design-system/_ds_manifest.json` is an
abridged manifest noting the same inline.

## File inventory

| Path | What it is |
|---|---|
| `well-regarded-dashboard.dc.html` | The designer's dashboard mockup — inline-styled HTML in the Claude Design `dc` template format (8 screens behind client-side state, seeded demo data in a `text/x-dc` script). |
| `support.js` | The dc-runtime that renders the mockup. Self-loads React/ReactDOM 18.3.1 UMD from unpkg (SRI-pinned) at runtime. |
| `design-system/readme.md` | **The authoritative design-language spec** — voice, color, type, spacing, corners, motion, iconography, caveats. Read this first. |
| `design-system/styles.css` | Global entry; imports everything under `tokens/`. |
| `design-system/tokens/colors.css` | Ink/gray/accent ramps + semantic aliases (`--text-*`, `--surface-*`, `--border-*`). |
| `design-system/tokens/typography.css` | Space Grotesk / IBM Plex Mono families, display and UI scales, tracking, tabular figures. |
| `design-system/tokens/spacing.css` | 4px grid; radii all 0 (`--radius-full` only for switch knobs/avatars). |
| `design-system/tokens/effects.css` | Flat shadows (`--shadow-card: none`), overlay shadow, motion (100–240ms, `cubic-bezier(0.2,0,0,1)`). |
| `design-system/tokens/fonts.css` | Google Fonts `@import` for Space Grotesk + IBM Plex Mono (substitutes — no brand font binaries exist). |
| `design-system/tokens/base.css` | Base element styles. |
| `design-system/_ds_bundle.js` | Compiled design-system runtime (`WellRegardedDesignSystem_71432a` global), with the 15 component JSX sources embedded. Generated file — do not hand-edit. |
| `design-system/_ds_manifest.json` | Abridged manifest: component list, starting points, global CSS order, fonts. Generated file. |
| `design-system/component-apis.md` | Extracted component prop contracts (from the design project's adherence lint config) — the designer-declared APIs for Button, Badge, Card, Tabs, Dialog, etc. |

## Viewing the mockup locally

The mockup loads its CSS and JS by relative path, so it needs a static server
(opening the file directly via `file://` will not resolve the imports cleanly):

```sh
cd design
python3 -m http.server 8000
# open http://localhost:8000/well-regarded-dashboard.dc.html
```

One honest caveat: the HTML does **not** include React itself. `support.js`
bootstraps it at runtime — `loadReactUmd()` injects React and ReactDOM 18.3.1
UMD builds from `unpkg.com` (SRI-pinned), and the Google Fonts come from a CDN
`@import` too. So viewing requires **internet access in addition to the static
server**. With both, the full interactive mockup renders (all 8 screens, the
reply dialog, the toast). Offline, the runtime hides the raw template and the
page stays blank, with `[dc] failed to load React or boot` in the console —
nothing meaningful renders without the CDN.

## DESIGN NOTES

What is actually in the mockup, as shipped. Direction (per the DS readme):
"hyper-modern, techy, editorial — stark white, near-black ink, hairline rules,
fully square corners, mono labels, one signal-green accent."

### App shell

- **Sidebar, 236px fixed**, sticky full-height, white with a 1px hairline right
  border. Top to bottom:
  - Wordmark "Well Regarded" in plain type — Space Grotesk 500 20px,
    −3% tracking (the DS forbids drawing a logo mark).
  - A mode chip: mono uppercase micro-label on `--accent-50` with a green dot,
    showing `{{ modeLabel }}` ("Full Trust Loop"; the props enum also offers
    "Activate Existing Signals").
  - **8 nav items**, each a 17px Lucide-style line icon (1.75 stroke) + label:
    **Today, Signals, Reviews, Recovery, Patient proof, Trust coverage,
    Insights, Presence**. Reviews carries a red mono count badge ("2"),
    Recovery ("1"). Active item: `--accent-700` text on `--accent-50`,
    weight 600; hover tints `--gray-50`. Corners square.
  - Footer (pinned with `margin-top:auto`, hairline top border): practice name
    "Cedar Ridge Dental", a `RatingStars` row showing **4.8** with value, and
    "214 reviews · 2 locations" in mono.
- **No global top bar.** Each screen opens with its own header block: an
  11px mono uppercase overline (+8% tracking, gray), a 32px Space Grotesk h1
  (−3% tracking), a 15px gray subhead, and occasionally a right-aligned primary
  button. Main column is `max-width:1120px`, padded 30/42px.

### Screens (8, switched client-side on `state.screen`)

1. **Today** — "Good morning" + "Your practice is already well regarded. Here
   is what needs you, and what does not." + primary **Send request** button.
   - A 4-up **stat strip** of hairline-bordered cards: mono overline label,
     30px tabular-figure value, mono subline — *Average rating 4.8 (up from
     4.6 this quarter) · New reviews · week 7 (6 responded) · Awaiting reply 3
     (oldest is 2 days old) · Open recovery 3 (1 urgent)*.
   - **Needs your attention** card: 5 rows separated by hairline top borders,
     each with a status dot (red/amber/green), a Badge tag (Urgent, Recovery
     due, Awaiting approval, Profile, Proof), a title, mono meta, and a green
     mono uppercase CTA ("Recovery →", "Reviews →") that deep-links to the
     relevant screen.
   - **Weekly trust brief**: an inverse `--ink-900` panel — accent-green mono
     overline, a Space Grotesk lede ("What happened, and what deserves a
     look."), then 6 label/body rows on `--ink-700` hairlines: *Patients
     appreciated, Worth looking at, Needs follow-up, Public reputation, Trust
     opportunity, Profile health*.
2. **Signals** — "Every legitimate piece of patient evidence, public or
   private, with its source and rights preserved." A borderless table (grid
   `96px / 1fr / 150px`) with mono uppercase column heads **Source / Signal /
   Rights**. Rows: source (Google, Post-visit, Survey import, Healthgrades,
   Manual entry) with an outlined PUBLIC/PRIVATE micro-badge (green vs gray);
   the signal text set in mono like a log line; **dashed-border chips** for
   extracted entities, with inferred ones suffixed "· inferred" in lighter
   dashed gray; a sentiment Badge (Positive/Negative/Mixed → positive/negative/
   caution tones); and a color-coded consent line (green for granted/eligible,
   red "Consent missing", amber "Pending permission").
3. **Reviews** — response workspace. `Tabs` with counts (All 7 · Awaiting
   reply 3 · Needs attention 1 · Replied 3), then `Tag` source-filter chips
   (All sources, Google, Healthgrades). Each review row: `RatingStars`, author,
   mono meta ("Google · Yesterday"), an optional red-outlined **Response
   risk** micro-badge, a status Badge; the review text in mono inside curly
   quotes; gray theme chips ("Dental anxiety", "Wait time"); an association
   line ("Dr. Aldana · inferred", "Main Street · confirmed"); and either a
   secondary-sm **Review reply** button or a green mono "✓ Replied". Seven
   seeded reviews, including a 2-star billing complaint flagged high-risk.
4. **Recovery** — "Concerns become work, not just reputational risk." A queue
   of hairline-separated rows: priority Badge (Urgent/High/Medium/Low),
   location, an amber "↻ 2 similar this quarter" recurrence note where
   relevant, and a plain-sentence description; a 220px right rail (hairline
   left border) holds mono **Owner / Due / Contact** key-values, with urgent
   due dates in red.
5. **Patient proof** — governed testimonial library, 2-up cards: type overline
   (Testimonial, Public review, Imported testimonial, Video testimonial,
   Post-visit comment), a status Badge (**Ready / Needs permission / Awaiting
   patient**), a mono quote, attribution ("Jordan M. · first name, with
   consent"), then hairline-topped **Consent** and **Placement** rows —
   consent values color-coded, e.g. "Consent not documented" in red with
   placement "Restricted to internal analysis".
6. **Trust coverage** — "A 4.8 rating can still hide gaps." A dark
   recommendation banner calling out weak spots with green-highlighted
   entities (Invisalign, Dr. Shah, North's response time). A three-state
   traffic-light legend using **square** swatches: green "Well covered", amber
   "Thin — some, but dated or sparse", red "Gap — little credible proof".
   Then: a full-width **Patient-concern coverage** grid of eight prospective-
   patient questions ("Will this hurt?", "Will I understand the cost?", "Will
   the result look natural?") each with a status swatch; and **By service** /
   **By provider & location** hairline lists with mono notes ("42 recent",
   "0 recent", "no public proof", "19h response").
7. **Insights** — **Experience themes** list: mono direction glyphs ▲ ▼ —
   (green/red/gray), theme, mono note ("praised more", "watch North"), and a
   tabular mono count. **Review velocity**: a minimal bar chart of six solid
   `--accent-600` bars labeled W1–W6 ("New reviews per week · last six
   weeks"). **By location**: a compact mono table comparing Main Street
   (4.9 · 4h · 1 open) with North (4.6 · 19h in amber · 2 open).
8. **Presence** — per-location profile-health cards. Main Street gets a
   positive "Healthy" Badge; North a caution "4 to fix". Items with square
   green/amber/red dots and mono right-aligned notes: holiday hours not set
   (Google), broken appointment link (404), duplicate profile (Bing), outdated
   photos (2023), unanswered profile questions.

### Overlays

- **Reply dialog** (`Dialog`, 580px): the review quoted in a sunken hairline
  box; when flagged, a red-bordered **"Privacy-safe check"** panel listing
  what the public reply must not say ("Do not confirm a specific treatment…",
  "Keep insurance and billing details out of the public reply."); an editable
  textarea under "Suggested reply · you can edit" / "Draft · not published";
  footer: mono "Publishes to Google after approval." + ghost **Cancel** +
  primary **Approve and publish**. Approval is explicitly human-in-the-loop.
- **Toast**: hand-rolled inverse `--ink-900` bar, bottom-center, green check
  icon — "Reply published to Google.", "Feedback request queued for eligible
  visits."

### Component inventory actually used

From the DS runtime (`x-import` of `WellRegardedDesignSystem_71432a.*`):
**Button** (primary, `secondary` `sm`, `ghost`), **Badge** (tones positive /
caution / negative / neutral), **RatingStars** (with and without value),
**Tabs** (with counts), **Tag** (selectable filter chips), **Dialog**.
Hand-built inline rather than imported: stat cards and section cards (bordered
divs, not the `Card` component), the toast, the outlined micro-badges
(PUBLIC/PRIVATE, "Response risk"), dashed entity chips, the bar chart, and all
tables/lists. `IconButton`, `Input`, `Select`, `Checkbox`, `RadioGroup`,
`Switch`, `Toast`, `Tooltip` exist in the DS but do not appear in this mock.

### Notable patterns

- **Square corners everywhere** — the only `border-radius` in the mock is
  `50%` on tiny status dots and the mode-chip dot (matching the DS rule that
  `--radius-full` survives only for knobs/avatars).
- **Hairline rules instead of boxes**: list rows separate with
  `border-top:1px solid var(--border-default)`; the concern grid uses 1px
  gaps on a gray background. No shadows except the toast's overlay shadow.
- **Mono micro-labels**: 10–11px IBM Plex Mono, uppercase, +6–8% tracking, for
  every overline, column head, key-value label, and CTA.
- **Quotes and data read like logs**: review excerpts, signal text, and all
  metadata are set in mono; metrics use tabular figures.
- **One green accent** (`--accent-*`): links, active nav, stars, live/positive
  status, highlighted entities in the dark banners. Red and amber appear only
  as semantic status colors. No gradients, no blur.
- **Dark ink-900 inverse panels as the "system voice"**: the weekly brief, the
  coverage recommendation, the toast.
- Unicode glyphs (▲ ▼ ↻ ✓ →) appear **only inside mono strings**, per the DS.
- **Voice**: sentence case throughout, no exclamation points, understated
  paired sentences ("Here is what needs you, and what does not."), plain
  honest numbers ("4.8", "214 reviews · 2 locations", "oldest is 2 days old").

### Demo content the designer chose

Cedar Ridge Dental — 2 locations (Main Street, North), providers Dr. Aldana,
Dr. Patel, Dr. Shah (new, no public proof), a pediatric/hygiene team; 4.8
average across 214 reviews; screen date "Thursday, July 10", brief "Week of
Jul 7". Recurring narrative threads run across screens: the 2-star billing
complaint (Reviews → Recovery → Today), Tuesday-afternoon waits (Signals →
Recovery → Insights), Invisalign as a proof gap (Coverage → Proof → Today),
and North's weaker profile health and response time (Presence → Insights →
Coverage).

## How this maps to the build

- **#115 — design system foundation.** The tokens under
  `design-system/tokens/` and the contracts in
  `design-system/component-apis.md` replace generic shadcn styling: radii are
  0 across the board, structure comes from 1px hairlines instead of shadows,
  Space Grotesk (display/UI) + IBM Plex Mono (labels/data/quotes) replace the
  default font stack, and `--accent-600` green is the single accent. The
  designer-declared prop vocabularies (Button `variant: primary·secondary·
  ghost·danger`, Badge `tone: neutral·brand·positive·caution·negative·gold`,
  etc.) should be preserved where sensible in the RR7 components; the
  adherence rules also ban raw hex colors, raw px values, and any other font.
  Icons are Lucide at 1.75 stroke, 16/20px, `currentColor` (a flagged
  substitution — no brand icons exist). Component JSX sources are embedded in
  `_ds_bundle.js` if a reference implementation is needed.
- **#132 — route skeletons.** The sidebar in the mock is the navigation
  contract: Today, Signals, Reviews, Recovery, Patient proof, Trust coverage,
  Insights, Presence — with red mono count badges on queue-like items and the
  active state as green-on-`--accent-50`. Empty-state copy should follow the
  DS voice rules: sentence case, no exclamation points, no emoji,
  understatement over hype ("A thoughtful way to ask. A simple way to keep
  up." is the house rhythm); the product speaks as a quiet assistant, "you/
  your" for the practice and "patients" for their customers.
- **Epic #5** generally: the mock demonstrates the full trust loop the epic
  describes — private feedback becomes Signals, public reviews get governed
  replies (approval-gated, privacy-checked), concerns become Recovery work
  items, permissioned quotes become Patient proof, and gaps surface as Trust
  coverage. The seeded data above doubles as a realistic fixture shape for
  those routes.
