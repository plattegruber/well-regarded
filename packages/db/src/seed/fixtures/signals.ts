/**
 * The demo practice's 80 signals — committed fixture data (issue #32
 * requirement 4), hand-written so the narratives read like a real dental
 * practice rather than lorem ipsum.
 *
 * Shape of the corpus (SEED CONTRACT — changes bump `SEED_VERSION`):
 *
 * - 44 Google reviews (public), skewed like a real corpus: 31 five-star,
 *   7 four-star, 2 three-star, 2 two-star, 2 one-star. Two are
 *   `deleted_at_source`.
 * - 12 `csv_import` rows — a legacy feedback export (private), all
 *   stamped with the deterministic demo `import_run_id`.
 * - 12 `firstparty` post-visit survey responses (private).
 * - 7 `email` feedback messages (private).
 * - 5 `manual` staff-logged notes (private).
 *
 * Recurring narrative threads mirror the designer's mockup
 * (design/README.md): the two-star billing complaint with a private email
 * follow-up, the Tuesday-afternoon wait cluster at North (urgency judged
 * `inferred_related`), implant anxiety relieved by Dr. Patel, cosmetic
 * outcomes, Invisalign as a *dated* proof gap, and Dr. Shah (the newer
 * associate) having only recent, private, unconsented evidence.
 *
 * Consent states across the corpus: active `patient_link` grants, a
 * superseded (narrowed) chain, `practice_attested`, `imported_unknown`,
 * one revoked, one expired — and the common case, no consent row at all
 * (~69 of 80 signals), for which publication must be impossible.
 */

import type { SourceKind } from "@wellregarded/core";

import type { LocationKey, PatientKey, ProviderKey } from "./demoPractice.js";

export type Sentiment = "positive" | "negative" | "mixed";
export type Urgency = "high" | "medium" | "low";
export type ResponseRisk = "high" | "medium" | "low";
export type PublicationSuitability = "suitable" | "needs_review" | "unsuitable";

export interface GrantFixture {
  source: "patient_link" | "practice_attested" | "imported_unknown";
  channels: ("website" | "gbp" | "email" | "in_office")[];
  attribution: "full_name" | "first_name" | "initials" | "anonymous";
  allowMinorEdits?: boolean;
  grantedDaysAgo: number;
  /** Days before the anchor the grant expires; positive = already expired. */
  expiresDaysAgo?: number;
}

export interface ConsentFixture {
  /**
   * Applied in order through `grantConsent` (the sanctioned versioning
   * path) — two entries model an append-only superseded chain.
   */
  grants: GrantFixture[];
  /** Revoke the final grant this many days before the anchor. */
  revokedDaysAgo?: number;
}

export interface ExcerptFixture {
  text: string;
  topics: string[];
}

export interface SignalFixture {
  /** Stable key — `seedId(\`signal:${key}\`)` is the row's primary key. */
  key: string;
  sourceKind: SourceKind;
  visibility: "public" | "private";
  /** `occurred_at` = anchor − daysAgo (+ a deterministic hour offset). */
  daysAgo: number;
  text: string;
  /** On the source's own scale (Google 1–5); omitted where unrated. */
  rating?: "1.0" | "2.0" | "3.0" | "4.0" | "5.0";
  location?: LocationKey;
  provider?: ProviderKey;
  patient?: PatientKey;
  /** The review no longer exists at the source. */
  deletedAtSource?: boolean;
  sentiment: Sentiment;
  /** Defaults to "low". */
  urgency?: Urgency;
  /**
   * Urgency judged from sibling signals (the Tuesday cluster) rather than
   * this text alone — emitted with basis `inferred_related`.
   */
  urgencyFromRelated?: boolean;
  /** A human re-classified sentiment; adds a `manual` derivation row. */
  manualSentiment?: Sentiment;
  /** Public signals get a response_risk derivation. */
  responseRisk?: ResponseRisk;
  publicationSuitability?: PublicationSuitability;
  consent?: ConsentFixture;
  excerpts?: ExcerptFixture[];
}

// ---------------------------------------------------------------------------
// Google reviews — public, rating-skewed like a real corpus.
// ---------------------------------------------------------------------------

const GOOGLE_SIGNALS: SignalFixture[] = [
  {
    key: "g01",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 12,
    rating: "5.0",
    text: "Dr. Aldana took the time to explain everything. I have never felt this at ease at a dentist.",
    location: "main_street",
    provider: "aldana",
    sentiment: "positive",
    responseRisk: "low",
    publicationSuitability: "suitable",
    excerpts: [
      {
        text: "Dr. Aldana took the time to explain everything. I have never felt this at ease at a dentist.",
        topics: ["dental anxiety", "treatment explanation"],
      },
    ],
  },
  {
    key: "g02",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 21,
    rating: "5.0",
    text: "Was nervous about my implant, but Dr. Patel walked me through each step. Much easier than I expected.",
    location: "main_street",
    provider: "patel",
    sentiment: "positive",
    responseRisk: "low",
    publicationSuitability: "suitable",
    excerpts: [
      {
        text: "Was nervous about my implant, but Dr. Patel walked me through each step. Much easier than I expected.",
        topics: ["implants", "dental anxiety"],
      },
    ],
  },
  {
    key: "g03",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 30,
    rating: "5.0",
    text: "The hygienist was gentle and thorough. My kids actually look forward to their visits now.",
    location: "north",
    provider: "kim",
    sentiment: "positive",
    responseRisk: "low",
    publicationSuitability: "suitable",
    excerpts: [
      {
        text: "The hygienist was gentle and thorough. My kids actually look forward to their visits now.",
        topics: ["pediatric", "hygiene", "staff warmth"],
      },
    ],
  },
  {
    key: "g04",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 6,
    rating: "2.0",
    text: "Charged for a service I was told insurance would cover. Still waiting on a callback about the crown from June.",
    location: "main_street",
    sentiment: "negative",
    urgency: "medium",
    responseRisk: "high",
  },
  {
    key: "g05",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 45,
    rating: "3.0",
    text: "Clean office and a polite front desk, but it took three calls to reschedule.",
    location: "north",
    sentiment: "mixed",
    responseRisk: "medium",
  },
  {
    key: "g06",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 300,
    rating: "1.0",
    text: "Waited forty-five minutes past my appointment time and nobody said a word.",
    location: "north",
    sentiment: "negative",
    urgency: "medium",
    responseRisk: "high",
  },
  {
    key: "g07",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 500,
    rating: "1.0",
    text: "Billed twice for the same cleaning. Getting it fixed took a month of phone calls.",
    sentiment: "negative",
    responseRisk: "high",
    deletedAtSource: true,
  },
  {
    key: "g08",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 60,
    rating: "4.0",
    text: "Great cleaning and a friendly team. Parking behind the building is very tight though.",
    location: "main_street",
    sentiment: "positive",
    // A human re-read this one and downgraded it — the parking complaint
    // is actionable, so it should surface as mixed, not pure praise.
    manualSentiment: "mixed",
    responseRisk: "low",
  },
  {
    key: "g09",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 25,
    rating: "3.0",
    text: "Good dentist, but Tuesday afternoons are chaos. The waiting room was standing room only.",
    location: "north",
    sentiment: "mixed",
    urgency: "medium",
    urgencyFromRelated: true,
    responseRisk: "medium",
  },
  {
    key: "g10",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 90,
    rating: "5.0",
    text: "My veneers look completely natural. Dr. Patel matched the shade so well my own sister could not tell.",
    location: "main_street",
    provider: "patel",
    sentiment: "positive",
    responseRisk: "low",
    publicationSuitability: "suitable",
    excerpts: [
      {
        text: "My veneers look completely natural. Dr. Patel matched the shade so well my own sister could not tell.",
        topics: ["cosmetic", "veneers"],
      },
    ],
  },
  {
    key: "g11",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 130,
    rating: "5.0",
    text: "Did the in-office whitening two weeks before my wedding. The photos speak for themselves.",
    location: "main_street",
    sentiment: "positive",
    responseRisk: "low",
    publicationSuitability: "suitable",
    excerpts: [
      {
        text: "Did the in-office whitening two weeks before my wedding. The photos speak for themselves.",
        topics: ["cosmetic", "whitening"],
      },
    ],
  },
  {
    // Deliberately dated: the mockup's coverage screen calls Invisalign a
    // proof gap — the only evidence is old.
    key: "g12",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 600,
    rating: "5.0",
    text: "Finished my Invisalign last spring. Straight teeth, no drama, and the check-ins were quick.",
    sentiment: "positive",
    responseRisk: "low",
  },
  {
    key: "g13",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 8,
    rating: "5.0",
    text: "Dr. Aldana put the x-rays up and explained the treatment plan option by option. Nobody has ever done that for me.",
    location: "main_street",
    provider: "aldana",
    sentiment: "positive",
    responseRisk: "low",
  },
  {
    key: "g14",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 17,
    rating: "5.0",
    text: "The front desk at the North office greeted my grandmother by name and helped her with the forms.",
    location: "north",
    sentiment: "positive",
    responseRisk: "low",
  },
  {
    key: "g15",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 38,
    rating: "5.0",
    text: "First dental visit for my three-year-old and Dr. Kim made it feel like a game. No tears, even at the end.",
    location: "north",
    provider: "kim",
    sentiment: "positive",
    responseRisk: "low",
  },
  {
    key: "g16",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 52,
    rating: "5.0",
    text: "Two fillings and I barely felt the numbing shot. Over before I knew it.",
    location: "main_street",
    sentiment: "positive",
    responseRisk: "low",
  },
  {
    key: "g17",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 75,
    rating: "5.0",
    text: "I dreaded this root canal for weeks. Dr. Aldana had it done in under an hour and I drove myself home fine.",
    location: "main_street",
    provider: "aldana",
    sentiment: "positive",
    responseRisk: "low",
  },
  {
    key: "g18",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 84,
    rating: "4.0",
    text: "Good visit overall. The waiting room runs warm and the TV is loud, but the care itself was excellent.",
    location: "main_street",
    sentiment: "positive",
    responseRisk: "low",
  },
  {
    key: "g19",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 100,
    rating: "5.0",
    text: "Chipped a tooth on a Saturday morning and they fit me in the same day at the North office. Lifesavers.",
    location: "north",
    sentiment: "positive",
    responseRisk: "low",
  },
  {
    key: "g20",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 110,
    rating: "5.0",
    text: "Dr. Patel replaced a twenty-year-old bridge. It fits better than the original ever did.",
    location: "main_street",
    provider: "patel",
    sentiment: "positive",
    responseRisk: "low",
  },
  {
    key: "g21",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 145,
    rating: "5.0",
    text: "They remember your name here. Small thing, but it makes the whole visit feel different.",
    location: "main_street",
    sentiment: "positive",
    responseRisk: "low",
  },
  {
    key: "g22",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 160,
    rating: "4.0",
    text: "The new online check-in actually works. Cleaning was thorough. Would be five stars if the phone line were easier.",
    location: "north",
    sentiment: "positive",
    responseRisk: "low",
  },
  {
    key: "g23",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 180,
    rating: "5.0",
    text: "The office manager called my insurance while I waited and sorted out a pre-authorization in one visit.",
    location: "main_street",
    sentiment: "positive",
    responseRisk: "low",
  },
  {
    key: "g24",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 200,
    rating: "5.0",
    text: "Dr. Kim told us honestly that our daughter did not need braces yet. You do not forget honesty like that.",
    location: "north",
    provider: "kim",
    sentiment: "positive",
    responseRisk: "low",
  },
  {
    key: "g25",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 220,
    rating: "5.0",
    text: "Gentlest cleaning I have ever had. My gums did not ache afterward for the first time in years.",
    location: "main_street",
    sentiment: "positive",
    responseRisk: "low",
  },
  {
    key: "g26",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 240,
    rating: "5.0",
    text: "Evening appointments mean I do not have to take time off work anymore. Quality care on top of that.",
    location: "north",
    sentiment: "positive",
    responseRisk: "low",
  },
  {
    key: "g27",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 260,
    rating: "4.0",
    text: "Crown needed a second visit to fit right. They handled the adjustment quickly and did not charge for it.",
    location: "main_street",
    sentiment: "mixed",
    responseRisk: "medium",
  },
  {
    key: "g28",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 280,
    rating: "5.0",
    text: "I told Dr. Aldana about my anxiety and she went over every sedation option without making me feel silly.",
    location: "main_street",
    provider: "aldana",
    sentiment: "positive",
    responseRisk: "low",
  },
  {
    key: "g29",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 320,
    rating: "5.0",
    text: "We moved across town two years ago and still make the drive. That should tell you everything.",
    location: "main_street",
    sentiment: "positive",
    responseRisk: "low",
  },
  {
    key: "g30",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 350,
    rating: "5.0",
    text: "Needed a deep cleaning and they explained the cost up front, in writing, before starting. No surprises.",
    location: "north",
    sentiment: "positive",
    responseRisk: "low",
  },
  {
    key: "g31",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 380,
    rating: "5.0",
    text: "They adjusted my mother's dentures three times until they were right and never once acted rushed.",
    location: "main_street",
    sentiment: "positive",
    responseRisk: "low",
  },
  {
    key: "g32",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 400,
    rating: "4.0",
    text: "Solid cleaning and a kind hygienist. Fifteen-minute wait past my slot, but they apologized for it.",
    location: "north",
    sentiment: "positive",
    responseRisk: "low",
  },
  {
    key: "g33",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 430,
    rating: "5.0",
    text: "Fixed my chipped front tooth over a lunch break. You cannot tell which one it was.",
    location: "main_street",
    sentiment: "positive",
    responseRisk: "low",
  },
  {
    key: "g34",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 460,
    rating: "5.0",
    text: "Dr. Patel laid out the implant alternatives honestly, including the cheaper ones. I chose the implant anyway.",
    location: "main_street",
    provider: "patel",
    sentiment: "positive",
    responseRisk: "low",
  },
  {
    key: "g35",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 470,
    rating: "2.0",
    text: "Front desk was short with me when I asked questions about my statement. The dentistry is fine; the attitude was not.",
    location: "main_street",
    sentiment: "negative",
    responseRisk: "high",
  },
  {
    key: "g36",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 490,
    rating: "5.0",
    text: "Friendly team, fair prices, and they run on time. What else do you want from a dentist?",
    location: "north",
    sentiment: "positive",
    responseRisk: "low",
    deletedAtSource: true,
  },
  {
    key: "g37",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 520,
    rating: "5.0",
    text: "Whitening touch-up before reunion season. Quick, painless, and the results lasted.",
    location: "main_street",
    sentiment: "positive",
    responseRisk: "low",
  },
  {
    key: "g38",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 550,
    rating: "4.0",
    text: "The care is good. Reaching a human on the phone takes longer than it should.",
    location: "north",
    sentiment: "mixed",
    responseRisk: "medium",
  },
  {
    key: "g39",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 580,
    rating: "5.0",
    text: "Wisdom tooth out with zero complications. Dr. Aldana called me herself the next morning to check in.",
    location: "main_street",
    provider: "aldana",
    sentiment: "positive",
    responseRisk: "low",
  },
  {
    key: "g40",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 610,
    rating: "5.0",
    text: "New to town and picked this office off a neighbor's recommendation. The welcome visit won me over.",
    location: "north",
    sentiment: "positive",
    responseRisk: "low",
  },
  {
    key: "g41",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 640,
    rating: "5.0",
    text: "The hygienist taught my kids to floss with a puppet. They have not missed a night since.",
    location: "main_street",
    sentiment: "positive",
    responseRisk: "low",
  },
  {
    key: "g42",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 670,
    rating: "5.0",
    text: "Same hygienist for five years now. She remembers which tooth is sensitive without checking the chart.",
    location: "north",
    sentiment: "positive",
    responseRisk: "low",
  },
  {
    key: "g43",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 700,
    rating: "4.0",
    text: "Reliable practice. One billing mix-up in three years, and they resolved it, though it took a few weeks.",
    location: "main_street",
    sentiment: "mixed",
    responseRisk: "medium",
  },
  {
    key: "g44",
    sourceKind: "google",
    visibility: "public",
    daysAgo: 715,
    rating: "5.0",
    text: "The cleanest dental office I have ever set foot in. You could eat off the floors.",
    location: "north",
    sentiment: "positive",
    responseRisk: "low",
  },
];

// ---------------------------------------------------------------------------
// CSV import — a legacy feedback export, private, older material. All rows
// carry the deterministic demo import_run_id (see ../constants.ts).
// ---------------------------------------------------------------------------

const CSV_SIGNALS: SignalFixture[] = [
  {
    key: "cs01",
    sourceKind: "csv_import",
    visibility: "private",
    daysAgo: 420,
    text: "Everyone from the front desk to Dr. Aldana treated my mother with patience and real respect.",
    provider: "aldana",
    location: "main_street",
    sentiment: "positive",
    consent: {
      grants: [
        {
          source: "imported_unknown",
          channels: ["in_office"],
          attribution: "anonymous",
          grantedDaysAgo: 420,
        },
      ],
    },
  },
  {
    key: "cs02",
    sourceKind: "csv_import",
    visibility: "private",
    daysAgo: 450,
    text: "I have recommended Dr. Patel to three coworkers already. The implant consult alone was worth the visit.",
    provider: "patel",
    location: "main_street",
    sentiment: "positive",
    publicationSuitability: "suitable",
    consent: {
      // The practice attests this testimonial-book entry was given with
      // permission — no patient record exists (patient_id stays NULL).
      grants: [
        {
          source: "practice_attested",
          channels: ["website", "in_office"],
          attribution: "first_name",
          grantedDaysAgo: 445,
        },
      ],
    },
    excerpts: [
      {
        text: "I have recommended Dr. Patel to three coworkers already. The implant consult alone was worth the visit.",
        topics: ["implants", "referrals"],
      },
    ],
  },
  {
    key: "cs03",
    sourceKind: "csv_import",
    visibility: "private",
    daysAgo: 480,
    text: "The implant changed how I smile in photos. I stopped covering my mouth without noticing.",
    provider: "patel",
    patient: "ruth",
    sentiment: "positive",
    consent: {
      // Granted long ago with an expiry that has since passed — the
      // "expired" consent state.
      grants: [
        {
          source: "patient_link",
          channels: ["website"],
          attribution: "initials",
          grantedDaysAgo: 470,
          expiresDaysAgo: 105,
        },
      ],
    },
  },
  {
    key: "cs04",
    sourceKind: "csv_import",
    visibility: "private",
    daysAgo: 500,
    text: "Gentle with my daughter and explained everything at her eye level. She asked when she gets to go back.",
    provider: "kim",
    location: "north",
    sentiment: "positive",
    consent: {
      grants: [
        {
          source: "imported_unknown",
          channels: ["in_office"],
          attribution: "anonymous",
          grantedDaysAgo: 500,
        },
      ],
    },
  },
  {
    key: "cs05",
    sourceKind: "csv_import",
    visibility: "private",
    daysAgo: 520,
    text: "After years of avoiding dentists, this is the first office I actually trust. That is not a small thing for me.",
    patient: "gloria",
    location: "main_street",
    sentiment: "positive",
    publicationSuitability: "suitable",
    consent: {
      grants: [
        {
          source: "patient_link",
          channels: ["website", "email"],
          attribution: "initials",
          grantedDaysAgo: 510,
        },
      ],
    },
    excerpts: [
      {
        text: "After years of avoiding dentists, this is the first office I actually trust.",
        topics: ["dental anxiety", "trust"],
      },
    ],
  },
  {
    key: "cs06",
    sourceKind: "csv_import",
    visibility: "private",
    daysAgo: 540,
    text: "Scheduling was easy, the cleaning was quick, and I was back at work before my lunch hour ended.",
    location: "main_street",
    sentiment: "positive",
  },
  {
    key: "cs07",
    sourceKind: "csv_import",
    visibility: "private",
    daysAgo: 560,
    text: "Best dental visit I have had, and I have had plenty. The hygienist narrated everything before doing it.",
    sentiment: "positive",
    consent: {
      grants: [
        {
          source: "imported_unknown",
          channels: ["in_office"],
          attribution: "anonymous",
          grantedDaysAgo: 560,
        },
      ],
    },
  },
  {
    key: "cs08",
    sourceKind: "csv_import",
    visibility: "private",
    daysAgo: 580,
    text: "Survey note: the waiting area gets cramped on weekday afternoons. Care itself was fine.",
    location: "north",
    sentiment: "mixed",
  },
  {
    key: "cs09",
    sourceKind: "csv_import",
    visibility: "private",
    daysAgo: 620,
    text: "The hygiene team here is the most careful I have experienced. My gums have never been healthier.",
    sentiment: "positive",
  },
  {
    key: "cs10",
    sourceKind: "csv_import",
    visibility: "private",
    daysAgo: 650,
    text: "The billing statement confused me at first. The front desk sorted it out, but it took two visits.",
    location: "main_street",
    sentiment: "negative",
    // A human reviewed the import and softened the model's call: the
    // issue resolved, so mixed is the fairer read.
    manualSentiment: "mixed",
  },
  {
    key: "cs11",
    sourceKind: "csv_import",
    visibility: "private",
    daysAgo: 680,
    text: "Dr. Aldana caught an issue two other dentists had missed. I drive forty minutes now and do not mind.",
    provider: "aldana",
    sentiment: "positive",
  },
  {
    key: "cs12",
    sourceKind: "csv_import",
    visibility: "private",
    daysAgo: 710,
    text: "Kind people, clean rooms, honest advice. We have sent the whole family here for years.",
    sentiment: "positive",
  },
];

// ---------------------------------------------------------------------------
// First-party post-visit surveys — private, recent.
// ---------------------------------------------------------------------------

const FIRSTPARTY_SIGNALS: SignalFixture[] = [
  {
    key: "fp01",
    sourceKind: "firstparty",
    visibility: "private",
    daysAgo: 14,
    text: "I was terrified going into this, but Dr. Patel explained every step and it was much easier than I expected.",
    location: "main_street",
    provider: "patel",
    patient: "jordan",
    sentiment: "positive",
    publicationSuitability: "suitable",
    consent: {
      // The mockup's proof library: "Jordan M. · first name, with consent",
      // consented for Website until revoked.
      grants: [
        {
          source: "patient_link",
          channels: ["website", "in_office"],
          attribution: "first_name",
          allowMinorEdits: true,
          grantedDaysAgo: 10,
        },
      ],
    },
    excerpts: [
      {
        text: "I was terrified going into this, but Dr. Patel explained every step and it was much easier than I expected.",
        topics: ["implants", "dental anxiety"],
      },
      {
        text: "Dr. Patel explained every step.",
        topics: ["treatment explanation"],
      },
    ],
  },
  {
    key: "fp02",
    sourceKind: "firstparty",
    visibility: "private",
    daysAgo: 28,
    text: "The new online check-in worked perfectly and the hygienist was wonderful with both of my kids.",
    location: "north",
    provider: "kim",
    patient: "priya",
    sentiment: "positive",
    publicationSuitability: "suitable",
    consent: {
      // An append-only superseded chain: first granted broadly under her
      // full name, then narrowed to first-name website-only a week later.
      grants: [
        {
          source: "patient_link",
          channels: ["website", "gbp"],
          attribution: "full_name",
          grantedDaysAgo: 25,
        },
        {
          source: "patient_link",
          channels: ["website"],
          attribution: "first_name",
          grantedDaysAgo: 18,
        },
      ],
    },
    excerpts: [
      {
        text: "The new online check-in worked perfectly and the hygienist was wonderful with both of my kids.",
        topics: ["pediatric", "check-in", "hygiene"],
      },
    ],
  },
  {
    key: "fp03",
    sourceKind: "firstparty",
    visibility: "private",
    daysAgo: 9,
    text: "The wait on Tuesday afternoon was long and checkout felt rushed.",
    location: "north",
    patient: "marcus",
    sentiment: "negative",
    urgency: "medium",
    urgencyFromRelated: true,
  },
  {
    key: "fp04",
    sourceKind: "firstparty",
    visibility: "private",
    daysAgo: 23,
    text: "Second visit in a row where Tuesday afternoon ran late. The care is great; the schedule is not.",
    location: "north",
    patient: "elena",
    sentiment: "negative",
    urgency: "medium",
    urgencyFromRelated: true,
  },
  {
    key: "fp05",
    sourceKind: "firstparty",
    visibility: "private",
    daysAgo: 37,
    text: "Forty-five minutes in the waiting room on a Tuesday. Please fix this — everything else about the visit was fine.",
    location: "north",
    sentiment: "negative",
    urgency: "medium",
    urgencyFromRelated: true,
  },
  {
    key: "fp06",
    sourceKind: "firstparty",
    visibility: "private",
    daysAgo: 55,
    text: "Dr. Aldana made my crown appointment painless. You can quote me on that.",
    location: "main_street",
    provider: "aldana",
    patient: "devon",
    sentiment: "positive",
    consent: {
      // Granted, then revoked — the patient changed their mind twelve
      // days before the anchor. Publication must refuse with "revoked".
      grants: [
        {
          source: "patient_link",
          channels: ["website"],
          attribution: "first_name",
          grantedDaysAgo: 50,
        },
      ],
      revokedDaysAgo: 12,
    },
  },
  {
    key: "fp07",
    sourceKind: "firstparty",
    visibility: "private",
    daysAgo: 4,
    text: "Still swollen two days after the crown prep and starting to worry. I have called twice and not reached anyone.",
    location: "north",
    patient: "aiko",
    sentiment: "negative",
    urgency: "high",
    publicationSuitability: "unsuitable",
  },
  {
    key: "fp08",
    sourceKind: "firstparty",
    visibility: "private",
    daysAgo: 70,
    text: "Checkout finally feels quick since the new system. In and out in five minutes.",
    location: "north",
    sentiment: "positive",
  },
  {
    key: "fp09",
    sourceKind: "firstparty",
    visibility: "private",
    daysAgo: 95,
    text: "Dr. Kim let my son hold the mirror the whole time and named every tool. Zero tears, which is a first.",
    location: "north",
    provider: "kim",
    patient: "samuel",
    sentiment: "positive",
  },
  {
    key: "fp10",
    sourceKind: "firstparty",
    visibility: "private",
    daysAgo: 120,
    text: "Great cleaning as always. The music in the hygiene room was loud enough that I had to ask twice about aftercare.",
    location: "main_street",
    sentiment: "mixed",
  },
  {
    key: "fp11",
    sourceKind: "firstparty",
    visibility: "private",
    daysAgo: 160,
    text: "The estimate matched the final bill exactly. That is a first for me at any dentist.",
    location: "main_street",
    sentiment: "positive",
  },
  {
    key: "fp12",
    sourceKind: "firstparty",
    visibility: "private",
    daysAgo: 200,
    text: "I told them I hate needles and they adjusted everything about the visit around it. Grateful is the word.",
    location: "main_street",
    provider: "aldana",
    patient: "hannah",
    sentiment: "positive",
    consent: {
      grants: [
        {
          source: "patient_link",
          channels: ["in_office"],
          attribution: "anonymous",
          grantedDaysAgo: 190,
        },
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// Email feedback — private.
// ---------------------------------------------------------------------------

const EMAIL_SIGNALS: SignalFixture[] = [
  {
    key: "em01",
    sourceKind: "email",
    visibility: "private",
    daysAgo: 33,
    text: "My husband saw Dr. Patel for two implants this spring. Last night he ate an apple for the first time in four years and got emotional at the kitchen table. Thank you all, truly.",
    location: "main_street",
    provider: "patel",
    sentiment: "positive",
    publicationSuitability: "suitable",
    consent: {
      grants: [
        {
          source: "practice_attested",
          channels: ["website"],
          attribution: "initials",
          grantedDaysAgo: 30,
        },
      ],
    },
    excerpts: [
      {
        text: "Last night he ate an apple for the first time in four years and got emotional at the kitchen table.",
        topics: ["implants", "outcomes"],
      },
    ],
  },
  {
    // The mockup's urgent thread: escalated to Dr. Shah at North. Private,
    // clinical, and absolutely not publishable.
    key: "em02",
    sourceKind: "email",
    visibility: "private",
    daysAgo: 2,
    text: "It has been two days since my extraction and the pain is getting worse, not better. Please have someone call me back today.",
    location: "north",
    provider: "shah",
    patient: "ruth",
    sentiment: "negative",
    urgency: "high",
    publicationSuitability: "unsuitable",
  },
  {
    // Private follow-up to the public two-star billing review (g04).
    key: "em03",
    sourceKind: "email",
    visibility: "private",
    daysAgo: 7,
    text: "I received the statement for the June crown and I do not understand the insurance adjustment. Can someone walk me through it before the due date?",
    location: "main_street",
    patient: "marcus",
    sentiment: "negative",
    urgency: "medium",
  },
  {
    key: "em04",
    sourceKind: "email",
    visibility: "private",
    daysAgo: 48,
    text: "Dana at the Main Street desk squeezed me in before my flight and even printed my clearance letter. Above and beyond.",
    location: "main_street",
    sentiment: "positive",
  },
  {
    key: "em05",
    sourceKind: "email",
    visibility: "private",
    daysAgo: 85,
    text: "I left the consult unsure about the Invisalign financing options. Could someone explain how the monthly plan works?",
    location: "main_street",
    sentiment: "mixed",
  },
  {
    key: "em06",
    sourceKind: "email",
    visibility: "private",
    daysAgo: 140,
    text: "Lovely visit until checkout — I felt rushed out the door while still asking questions about my next appointment.",
    location: "north",
    sentiment: "negative",
  },
  {
    // Dr. Shah's only positive evidence is private and unconsented — the
    // "thin public evidence" narrative for the newer associate.
    key: "em07",
    sourceKind: "email",
    visibility: "private",
    daysAgo: 16,
    text: "Dr. Shah was thorough and kind at my first visit to the North office. She caught a cracked filling my old dentist had missed for years.",
    location: "north",
    provider: "shah",
    patient: "devon",
    sentiment: "positive",
  },
];

// ---------------------------------------------------------------------------
// Manual entries — staff-logged notes, private.
// ---------------------------------------------------------------------------

const MANUAL_SIGNALS: SignalFixture[] = [
  {
    key: "mn01",
    sourceKind: "manual",
    visibility: "private",
    daysAgo: 5,
    text: "Patient called to say the front desk went out of their way to fit her in same day. Wants to thank Dana personally.",
    location: "main_street",
    sentiment: "positive",
    // Worth asking for permission — but none granted yet, so it must not
    // be publishable (the mockup's "Pending permission" row).
    publicationSuitability: "needs_review",
  },
  {
    key: "mn02",
    sourceKind: "manual",
    visibility: "private",
    daysAgo: 26,
    text: "Longtime patient told Dr. Kim at checkout that the hygiene team is the reason the whole family stays with us.",
    location: "north",
    provider: "kim",
    sentiment: "positive",
  },
  {
    key: "mn03",
    sourceKind: "manual",
    visibility: "private",
    daysAgo: 64,
    text: "Caller complained about hold times on the North line two days running. Front desk logged it for the office manager.",
    location: "north",
    sentiment: "negative",
    urgency: "medium",
  },
  {
    key: "mn04",
    sourceKind: "manual",
    visibility: "private",
    daysAgo: 31,
    text: "Patient moving to Portland asked how to transfer records. No complaint — praised the team on the way out.",
    location: "main_street",
    sentiment: "positive",
  },
  {
    key: "mn05",
    sourceKind: "manual",
    visibility: "private",
    daysAgo: 88,
    text: "Saturday walk-in said we were the only office that answered the phone. Asked us to keep Saturday hours.",
    location: "main_street",
    sentiment: "positive",
  },
];

/**
 * All 80 signal fixtures, in insertion order. The integration test derives
 * its expected counts from this array, so the array is the contract.
 */
export const SIGNAL_FIXTURES: readonly SignalFixture[] = [
  ...GOOGLE_SIGNALS,
  ...CSV_SIGNALS,
  ...FIRSTPARTY_SIGNALS,
  ...EMAIL_SIGNALS,
  ...MANUAL_SIGNALS,
];
