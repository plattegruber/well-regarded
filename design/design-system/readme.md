# Well Regarded — Design System

**Well Regarded** is reputation software for professional practices (dental first). It automatically requests patient feedback, monitors reviews, and helps teams respond thoughtfully.

- Positioning: *A reputation that reflects the care you give.*
- Headline: *Become the practice patients feel good recommending.*
- Subhead: *Well Regarded automatically requests patient feedback, monitors your reviews, and helps your team respond thoughtfully.*

**Sources provided:** brand strategy prose only (name rationale, positioning, sample copy). No codebase, Figma, logo files, or font binaries were attached — everything visual here is an original system authored to fit the brand strategy. See CAVEATS at the end.

**Direction (v2):** hyper-modern, techy, editorial — infrastructure-software launch-day energy. Stark white, near-black ink, hairline rules, fully square corners, mono labels, one signal-green accent.

**No logo exists.** The wordmark is set in plain type: "Well Regarded" in Space Grotesk Medium, ink, tracking −3%. Do not draw a mark.

---

## CONTENT FUNDAMENTALS

**Voice:** calm, literate, respectful — a well-spoken practice manager, never a growth hacker. It describes the desired state ("well regarded"), not the machinery ("review automation").

- **Sentence case everywhere** — headings, body, nav. The only uppercase is mono micro-labels (and button labels, which are mono uppercase by component design).
- **"You/your" for the practice; "patients" for their customers.** The product speaks as a quiet assistant: "Well Regarded helps it travel," not "We supercharge your reviews!"
- **Full sentences with periods** in marketing copy, even short ones. UI microcopy may drop periods on fragments.
- **No emoji. No exclamation points.** Warmth comes from word choice, not punctuation.
- **Understatement over hype.** "A thoughtful way to ask. A simple way to keep up." Short paired sentences are a house rhythm.
- Numbers are plain and honest: "4.8", "132 reviews", "3 awaiting reply" — always in mono or tabular figures. No gamification.

Canonical copy examples:
- "Your practice is already well regarded. Your Google profile should show it."
- "Good care earns a good reputation. Well Regarded helps it travel."
- "The patients who appreciate you are often the ones least likely to remember to leave a review."

Button copy: verb-first, unhurried — "Send request", "Review reply", "See all feedback" (rendered uppercase mono by the component; write it in sentence case).

## VISUAL FOUNDATIONS

**Vibe:** launch-day infrastructure software with an editorial spine — pure white, ink black, precise mono annotations, one signal green.

- **Color:** pure white page ground, near-black ink (#0C0F0E) for chrome and primary actions, hairline gray rules (#E3E6E4) for structure. **Signal green** (#00915A) is the single accent — links, focus, stars, live data, checked states — and appears nowhere else. Dark inverse sections use flat ink-900. No gradients, ever.
- **Type:** Space Grotesk for display and UI (Medium 500 display at −3% tracking); IBM Plex Mono for labels, data, metadata, and review excerpts (quotes read like logs). Overline labels: 11px mono, uppercase, +8% tracking. Metrics use tabular figures.
- **Spacing:** 4px grid; generous sections (64–96px), cards pad 18–24px. Density is "documentation site", not "data terminal".
- **Backgrounds:** flat white or flat ink. No patterns, textures, photography, or illustration were provided — leave imagery slots as neutral blocks with a disclaimer rather than inventing.
- **Corners:** fully square. `--radius-sm/md/lg` are all 0; `--radius-full` survives only for switch knobs and avatars.
- **Borders & shadows:** flat surfaces; structure comes from 1px rules. Passive containers use hairline gray; interactive chrome (inputs, secondary buttons, tags) is outlined in ink black. No card shadows; only overlays (`--shadow-overlay`) float.
- **Motion:** instant and precise — 100–240ms, `cubic-bezier(0.2,0,0,1)`, fades and hairline transitions. Never bounce, never spin.
- **Hover:** ink lightens one step (ink-900 → ink-700); rows tint `--gray-50`. **Press:** darkens to pure black; no shrink transforms.
- **Focus:** 2px offset signal-green ring (`--focus-ring`).
- **Transparency/blur:** none; dialogs sit on a plain `rgba(12,15,14,.5)` scrim.
- **Stars** are signal green filled; empty stars `--gray-300`.

## ICONOGRAPHY

No icon assets were provided. The system uses **Lucide** (CDN, `lucide.dev`) at 1.75px stroke, sized 16/20px, colored `currentColor` — quiet line icons that match the precise chrome. This is a flagged substitution; swap in real brand icons if they exist. No emoji, no icon fonts. Stars are filled SVG paths (see `RatingStars`), the only filled glyphs. Unicode glyphs (▲ ▼ ★ ·) are permitted inside mono data strings only.

Usage: `<i data-lucide="star"></i>` with the Lucide script, or copy specific SVGs. Components that need icons accept them as children/props.

## INDEX

- `styles.css` — global entry; imports everything under `tokens/`.
- `tokens/` — colors (ink/gray/accent ramps + semantic aliases), typography, spacing, effects, fonts, base element styles.
- `guidelines/` — specimen cards shown in the Design System tab.
- `components/actions/` — Button, IconButton
- `components/forms/` — Input, Select, Checkbox, RadioGroup, Switch
- `components/display/` — Card, Badge, Tag, RatingStars
- `components/navigation/` — Tabs
- `components/overlay/` — Dialog, Toast, Tooltip
- `ui_kits/app/` — the Well Regarded product (dashboard, reviews inbox, feedback requests).
- `ui_kits/website/` — marketing site (landing page).
- `SKILL.md` — agent-facing usage guide.

**Intentional additions:** `RatingStars` — a reviews product needs a canonical star row; no source defined one.

## CAVEATS

- Fonts are Google substitutes (Space Grotesk, IBM Plex Mono) — no binaries were provided.
- No logo, icons, photography, or illustration assets were provided; none were invented.
- All components and UI kits are original designs derived from the brand strategy, not recreations.
