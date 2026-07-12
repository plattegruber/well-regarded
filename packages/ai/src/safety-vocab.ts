/**
 * Word lists for the deterministic privacy-safety layer (issue #72).
 *
 * These lists are DATA, not code — extend them freely (per-practice
 * extension can come later). Matching (word boundaries, plural handling,
 * the "your X" possessive window) lives in ./safety.ts; keep entries here
 * lowercase and singular where a plural is just `+s` / `+es` — the matcher
 * derives those. Multi-word entries match across any whitespace run.
 */

/**
 * Dental procedure / treatment vocabulary. A draft that names one of these
 * in a way that references the reviewer's own care ("your crown") is a
 * hard block; a generic mention ("we offer crowns") is a warn; a mention
 * of the practice's own offering ("our whitening options") is fine.
 */
export const PROCEDURE_TERMS: readonly string[] = [
  "root canal",
  "crown",
  "extraction",
  "implant",
  "filling",
  "denture",
  "veneer",
  "whitening",
  "cleaning",
  "deep cleaning",
  "x-ray",
  "xray",
  "novocaine",
  "anesthesia",
  "sedation",
  "braces",
  "invisalign",
  "aligner",
  "retainer",
  "periodontal",
  "gum graft",
  "scaling",
  "root planing",
  "cavity",
  "cavities",
  "wisdom tooth",
  "wisdom teeth",
  "oral surgery",
  "bonding",
  "sealant",
  "fluoride",
  "bite guard",
  "night guard",
  "bridge work",
  "dental bridge",
];

/**
 * Care-context nouns: generic on their own ("call us to book an
 * appointment" is fine), but "your <noun>" confirms a care relationship
 * or discloses treatment specifics → hard block. No generic-warn tier —
 * these words are everyday vocabulary.
 */
export const CARE_CONTEXT_TERMS: readonly string[] = [
  "appointment",
  "visit",
  "treatment",
  "treatment plan",
  "procedure",
  "prescription",
  "medication",
  "diagnosis",
  "chart",
  "records",
  "file",
  "balance",
  "account",
  "bill",
  "statement",
];

/**
 * Insurance vocabulary: a warn on any mention (billing conversations
 * belong in a private channel), a block when tied to the reviewer
 * ("your carrier", "your insurance").
 */
export const INSURANCE_TERMS: readonly string[] = [
  "insurance",
  "insurer",
  "claim",
  "copay",
  "co-pay",
  "copayment",
  "deductible",
  "eob",
  "explanation of benefits",
  "prior authorization",
  "preauthorization",
  "pre-authorization",
  "in-network",
  "out-of-network",
  "in network",
  "out of network",
  "carrier",
  "coverage",
  "premium",
];

/**
 * Insurance carrier names. Naming the reviewer's carrier is as good as
 * naming their plan — same warn/block tiers as INSURANCE_TERMS.
 */
export const INSURANCE_CARRIERS: readonly string[] = [
  "delta dental",
  "cigna",
  "aetna",
  "metlife",
  "guardian",
  "unitedhealthcare",
  "united healthcare",
  "humana",
  "anthem",
  "blue cross",
  "blue shield",
  "bcbs",
  "ameritas",
  "dentaquest",
  "careington",
  "physicians mutual",
  "renaissance dental",
];

/**
 * Number words for spelled-out dollar amounts ("four hundred fifty
 * dollars"). Used by the dollar-amount rule in ./safety.ts.
 */
export const NUMBER_WORDS: readonly string[] = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
  "hundred",
  "thousand",
];

/**
 * Full month names that block even bare ("we're open until March" is an
 * accepted over-block per the issue — a false block is a cheap edit, a
 * leaked date is not). "may" is deliberately absent: it is a modal verb
 * far more often than a month, so it lives in MONTHS_NEEDING_NUMBER.
 */
export const MONTH_NAMES_BARE: readonly string[] = [
  "january",
  "february",
  "march",
  "april",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/**
 * Month tokens that only count as a date when followed by a day or year
 * number ("May 3rd", "Jan 2025"): "may" (modal verb) and abbreviations
 * ("mar", "sep", ... collide with ordinary words and names).
 */
export const MONTHS_NEEDING_NUMBER: readonly string[] = [
  "may",
  "jan",
  "feb",
  "mar",
  "apr",
  "jun",
  "jul",
  "aug",
  "sept",
  "sep",
  "oct",
  "nov",
  "dec",
];

/** Weekday names for the relative-day rule. */
export const WEEKDAY_NAMES: readonly string[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];
