/**
 * Response templates (issue #83, Epic #10) — the pure vocabulary and
 * helpers behind the `response_templates` table in `@wellregarded/db` and
 * the Settings → Templates CRUD in the dashboard.
 *
 * A template is a response waiting to happen, so the same discipline that
 * governs the composer governs templates: the body may contain ONLY the
 * whitelisted placeholders below ({@link TEMPLATE_PLACEHOLDERS} — enforced
 * by {@link lintTemplateBody} at save time), and the save action runs the
 * full `checkResponseSafety` over the body with neutral dummy values
 * substituted ({@link TEMPLATE_SAFETY_DUMMY_REVIEWER}) so an unsafe
 * template is never storable.
 *
 * `renderTemplate` is the one substitution path (issue #83 requirement 6):
 * the composer's insert-into-draft, the save-time safety render, and any
 * future consumer all call it. Unknown placeholders are left literal —
 * rendering never invents content — and reported by the linter instead.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

/**
 * The ONLY placeholders a template body may use. This is a whitelist, not
 * a convention: `lintTemplateBody` rejects anything else at save time, so
 * a template can never smuggle in a `{last_visit_date}`-shaped field that
 * would tempt someone to wire private context into a public reply.
 */
export const TEMPLATE_PLACEHOLDERS = [
  "reviewer_name",
  "practice_name",
] as const;

export type TemplatePlaceholder = (typeof TEMPLATE_PLACEHOLDERS)[number];

/** Values for one render; a missing/empty value leaves the token literal. */
export type TemplateVars = Partial<Record<TemplatePlaceholder, string>>;

/** Matches `{token}` occurrences: word-ish token names, no nesting. */
const PLACEHOLDER_RE = /\{([a-zA-Z0-9_]+)\}/g;

/**
 * Substitute whitelisted placeholders. Unknown placeholders — and
 * whitelisted ones with no value provided — are left literal, so the
 * caller can see (and the CRUD UI can flag) exactly what did not resolve.
 */
export function renderTemplate(body: string, vars: TemplateVars): string {
  return body.replace(PLACEHOLDER_RE, (token, name: string) => {
    if (!(TEMPLATE_PLACEHOLDERS as readonly string[]).includes(name)) {
      return token;
    }
    const value = vars[name as TemplatePlaceholder];
    return value === undefined ? token : value;
  });
}

export interface TemplateLintResult {
  /** Placeholder names used in the body that are not whitelisted. */
  unknownPlaceholders: string[];
  /** Whitelisted placeholder names the body actually uses. */
  usedPlaceholders: TemplatePlaceholder[];
}

/**
 * The template linter (issue #83 requirement, the save gate's first
 * layer): report every `{token}` that is not on the whitelist. The CRUD
 * action rejects the save when `unknownPlaceholders` is non-empty.
 */
export function lintTemplateBody(body: string): TemplateLintResult {
  const unknown = new Set<string>();
  const used = new Set<TemplatePlaceholder>();
  for (const match of body.matchAll(PLACEHOLDER_RE)) {
    const name = match[1] as string;
    if ((TEMPLATE_PLACEHOLDERS as readonly string[]).includes(name)) {
      used.add(name as TemplatePlaceholder);
    } else {
      unknown.add(name);
    }
  }
  return {
    unknownPlaceholders: [...unknown],
    usedPlaceholders: [...used],
  };
}

/**
 * Neutral dummy reviewer name for the save-time safety render (issue #83
 * requirement 3): the safety check must see realistic prose, not literal
 * `{reviewer_name}` tokens; "Alex" is deliberately unisex and generic.
 */
export const TEMPLATE_SAFETY_DUMMY_REVIEWER = "Alex";

// ---------------------------------------------------------------------------
// Tone tags and the boundary schema
// ---------------------------------------------------------------------------

/**
 * The starter tone vocabulary. Deliberately data (a text column), not a
 * Postgres enum — the vocabulary will evolve without migrations. The form
 * schema validates against the CURRENT vocabulary so the picker and the
 * data stay honest; extending it is a one-line change here.
 */
export const TEMPLATE_TONES = ["warm", "neutral", "apologetic"] as const;

export type TemplateTone = (typeof TEMPLATE_TONES)[number];

/**
 * Boundary schema for the template create/edit form (dashboard Settings →
 * Templates; a future API endpoint must reuse it). Body length is capped
 * well under the GBP 4096-byte reply limit — a template that cannot be
 * sent is not a template.
 */
export const responseTemplateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the template a name.")
    .max(80, "Keep the name under 80 characters."),
  body: z
    .string()
    .trim()
    .min(1, "Write the template body.")
    .max(3500, "Keep templates well under the reply length limit."),
  tone: z.enum(TEMPLATE_TONES, {
    error: "Choose a tone from the list.",
  }),
});

export type ResponseTemplateInput = z.infer<typeof responseTemplateSchema>;

// ---------------------------------------------------------------------------
// Starter templates (issue #83 requirement 5)
// ---------------------------------------------------------------------------

export interface StarterTemplate {
  /** Stable key for deterministic seed ids. */
  key: string;
  name: string;
  tone: TemplateTone;
  body: string;
}

/**
 * The four starter templates seeded for every new practice (and the demo
 * practice). Copy rules: on-voice (sentence case, no exclamation points,
 * understatement over hype — design/design-system/readme.md), generic
 * (never confirms a care relationship, no treatment/billing/appointment
 * specifics), and safe — every body must pass the deterministic layer of
 * `checkResponseSafety`, which the seeding test asserts.
 */
export const STARTER_RESPONSE_TEMPLATES: readonly StarterTemplate[] = [
  {
    key: "positive",
    name: "Positive review",
    tone: "warm",
    body: "Thank you so much for the kind words, {reviewer_name}. Our team works hard to make every visit a comfortable one, and reviews like yours mean a lot to all of us at {practice_name}.",
  },
  {
    key: "negative_privacy_safe",
    name: "Negative review — privacy-safe",
    tone: "apologetic",
    body: "We're sorry to hear about your experience. We can't discuss any details publicly, but we'd genuinely like to understand what happened and make it right. Please call our office and ask for our practice manager.",
  },
  {
    key: "rating_no_comment",
    name: "Rating with no comment",
    tone: "neutral",
    body: "Thank you for taking the time to leave a rating. If there's anything you'd like to share about your experience, we're always listening — feel free to call or message us.",
  },
  {
    key: "mixed",
    name: "Mixed review",
    tone: "warm",
    body: "Thank you for the honest feedback, {reviewer_name}. We're glad some of it was positive, and we take the rest to heart — we're always working to do better. If you'd like to talk through anything, please reach out to our office.",
  },
];
