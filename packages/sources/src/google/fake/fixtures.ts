/**
 * Seeded fixture-data generator for the fake GBP server (issue #130).
 *
 * `generateFixturePractice` fills a {@link FakeGbpStore} with a realistic
 * dental practice: an account, N locations with full Presence profile
 * fields (hours, links, categories, photo counts — #156), and M reviews per
 * location covering the quirk matrix the adapter (#125) must survive:
 *
 * - star-only reviews (rating, no `comment`),
 * - edited reviews (`updateTime` > `createTime` — #123's incremental sync),
 * - replied reviews in every moderation state (APPROVED / PENDING /
 *   REJECTED-with-`policyViolation` — #127),
 * - anonymized reviewers ("A Google user").
 *
 * Determinism is the contract: same seed ⇒ byte-identical output (a tiny
 * mulberry32 PRNG, fixed epoch instead of wall clock, ids from the fresh
 * store's counters). The recorded-shape fixtures in
 * `src/google/fixtures/*.json` are generated from THIS code
 * (`pnpm --filter @wellregarded/sources gen:google-fixtures`) so the server
 * and the adapter fixtures cannot drift; a test pins that.
 *
 * The first six reviews of each location are pinned to the quirk matrix
 * (star-only, edited, replied×3 states, anonymized) so coverage never
 * depends on probability; the rest are randomized.
 */

import type { FakeGbpStore } from "./store.js";
import {
  type GbpAccount,
  type GbpLocation,
  type GbpReview,
  type GbpReviewReply,
  type GbpTimePeriod,
  type ReviewReplyState,
  type StarRating,
  starRatingValue,
} from "./types.js";

export interface GenerateFixturePracticeOptions {
  /** Number of locations. Default 2. */
  locations?: number;
  /** Reviews per location. Default 15 (≥6 guarantees full quirk coverage). */
  reviewsPerLocation?: number;
  /** PRNG seed. Same seed ⇒ identical data. Default 1. */
  seed?: number;
  /** Account display name. */
  accountName?: string;
}

export interface FixturePractice {
  account: GbpAccount;
  locations: GbpLocation[];
  reviews: GbpReview[];
}

/**
 * All fixture timestamps are relative to this fixed instant — never the
 * wall clock — so generation is reproducible forever.
 */
export const FIXTURE_EPOCH = "2026-06-30T12:00:00.000Z";
const EPOCH_MS = Date.parse(FIXTURE_EPOCH);

const DAY_MS = 24 * 60 * 60 * 1000;

export function generateFixturePractice(
  store: FakeGbpStore,
  options: GenerateFixturePracticeOptions = {},
): FixturePractice {
  const {
    locations: locationCount = 2,
    reviewsPerLocation = 15,
    seed = 1,
    accountName = "Cedar Ridge Dental Group",
  } = options;
  const rng = mulberry32(seed);

  const account = store.addAccount({ accountName });
  const locations: GbpLocation[] = [];
  const reviews: GbpReview[] = [];

  for (let l = 0; l < locationCount; l += 1) {
    const profile = LOCATION_PROFILES[l % LOCATION_PROFILES.length];
    if (!profile) throw new Error("unreachable: profile pool is non-empty");
    const location = store.addLocation({
      account: account.name,
      title: `${accountName.replace(/ Group$/, "")} — ${profile.branch}`,
      storefrontAddress: {
        regionCode: "US",
        languageCode: "en",
        postalCode: profile.postalCode,
        administrativeArea: "MI",
        locality: profile.locality,
        addressLines: [profile.addressLine],
      },
      phoneNumbers: { primaryPhone: profile.phone },
      categories: {
        primaryCategory: {
          name: "categories/gcid:dentist",
          displayName: "Dentist",
        },
        additionalCategories: [
          {
            name: "categories/gcid:cosmetic_dentist",
            displayName: "Cosmetic dentist",
          },
          {
            name: "categories/gcid:dental_hygienist",
            displayName: "Dental hygienist",
          },
        ],
      },
      websiteUri: profile.websiteUri,
      regularHours: { periods: DENTAL_HOURS },
      profile: {
        description:
          "Family and cosmetic dentistry: cleanings, crowns, implants, " +
          "Invisalign, and same-day emergency visits. New patients welcome.",
      },
      mediaItemCount: 4 + intBetween(rng, 0, 26),
      verified: true,
    });
    locations.push(location);

    for (let i = 0; i < reviewsPerLocation; i += 1) {
      reviews.push(generateReview(store, rng, location.name, i));
    }
  }

  return { account, locations, reviews };
}

// ---------------------------------------------------------------------------
// Review generation
// ---------------------------------------------------------------------------

type Quirk =
  | "star-only"
  | "edited"
  | "replied-approved"
  | "replied-rejected"
  | "anonymized"
  | "replied-pending"
  | "plain";

/** First six reviews per location pin the quirk matrix; the rest roll dice. */
const PINNED_QUIRKS: Quirk[] = [
  "star-only",
  "edited",
  "replied-approved",
  "replied-rejected",
  "anonymized",
  "replied-pending",
];

function generateReview(
  store: FakeGbpStore,
  rng: () => number,
  locationName: string,
  index: number,
): GbpReview {
  const quirk = PINNED_QUIRKS[index] ?? rollQuirk(rng);
  const starRating = pickStarRating(rng, quirk);
  const positive = starRatingValue(starRating) >= 4;

  const createMs =
    EPOCH_MS -
    intBetween(rng, 3, 540) * DAY_MS -
    intBetween(rng, 0, 86_399) * 1000;
  let updateMs = createMs;
  let comment: string | undefined;
  if (quirk !== "star-only") {
    comment = pick(
      rng,
      positive
        ? POSITIVE_COMMENTS
        : starRatingValue(starRating) === 3
          ? NEUTRAL_COMMENTS
          : NEGATIVE_COMMENTS,
    );
  }
  if (quirk === "edited" && comment) {
    updateMs = Math.min(
      createMs + intBetween(rng, 1, 30) * DAY_MS,
      EPOCH_MS - DAY_MS,
    );
    comment = `${comment} Edit: ${pick(rng, EDIT_ADDENDA)}`;
  }

  let reviewReply: GbpReviewReply | undefined;
  if (quirk.startsWith("replied")) {
    const replyMs = Math.min(
      Math.max(createMs, updateMs) + intBetween(rng, 1, 4) * DAY_MS,
      EPOCH_MS - 60_000,
    );
    const state: ReviewReplyState =
      quirk === "replied-approved"
        ? "APPROVED"
        : quirk === "replied-rejected"
          ? "REJECTED"
          : "PENDING";
    reviewReply = {
      comment: pick(
        rng,
        positive ? OWNER_REPLIES_POSITIVE : OWNER_REPLIES_NEGATIVE,
      ),
      updateTime: iso(replyMs),
      reviewReplyState: state,
      ...(state === "REJECTED"
        ? {
            policyViolation:
              "Reply removed for policy violation: contains personal health information.",
          }
        : {}),
    };
    // The store bumps a review's updateTime when its reply changes; keep
    // generated data consistent with that model.
    updateMs = Math.max(updateMs, replyMs);
  }

  const anonymous = quirk === "anonymized";
  const displayName = anonymous ? "A Google user" : pickName(rng);

  return store.addReview({
    location: locationName,
    reviewer: anonymous
      ? { displayName, isAnonymous: true }
      : {
          displayName,
          profilePhotoUrl: `https://lh3.googleusercontent.com/a/fake-${displayName.toLowerCase().replace(/[^a-z]+/g, "-")}`,
        },
    starRating,
    ...(comment !== undefined ? { comment } : {}),
    ...(reviewReply !== undefined ? { reviewReply } : {}),
    createTime: iso(createMs),
    updateTime: iso(updateMs),
  });
}

function rollQuirk(rng: () => number): Quirk {
  const roll = rng();
  if (roll < 0.12) return "star-only";
  if (roll < 0.28) return "edited";
  if (roll < 0.5) return "replied-approved";
  if (roll < 0.56) return "anonymized";
  return "plain";
}

function pickStarRating(rng: () => number, quirk: Quirk): StarRating {
  // Rejected replies in the wild cluster on angry reviews; keep those low.
  if (quirk === "replied-rejected") return rng() < 0.5 ? "ONE" : "TWO";
  const roll = rng();
  if (roll < 0.55) return "FIVE";
  if (roll < 0.75) return "FOUR";
  if (roll < 0.83) return "THREE";
  if (roll < 0.9) return "TWO";
  return "ONE";
}

// ---------------------------------------------------------------------------
// PRNG + picking
// ---------------------------------------------------------------------------

/** Tiny seeded PRNG (mulberry32) — deliberately not faker (issue #130). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function intBetween(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function pick<T>(rng: () => number, pool: readonly T[]): T {
  const item = pool[Math.floor(rng() * pool.length)];
  if (item === undefined) throw new Error("pick: empty pool");
  return item;
}

function pickName(rng: () => number): string {
  return `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)}`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// Content pools — dental-practice flavored, deliberately mundane.
// ---------------------------------------------------------------------------

const LOCATION_PROFILES = [
  {
    branch: "Downtown",
    addressLine: "412 Cedar Ridge Ave, Suite 200",
    locality: "Grand Rapids",
    postalCode: "49503",
    phone: "+16165550142",
    websiteUri: "https://cedarridgedental.example.com/downtown",
  },
  {
    branch: "Westside",
    addressLine: "88 Lakeshore Dr",
    locality: "Grandville",
    postalCode: "49418",
    phone: "+16165550178",
    websiteUri: "https://cedarridgedental.example.com/westside",
  },
  {
    branch: "North Park",
    addressLine: "2301 Plainfield Ave NE",
    locality: "Grand Rapids",
    postalCode: "49505",
    phone: "+16165550190",
    websiteUri: "https://cedarridgedental.example.com/north-park",
  },
] as const;

const DENTAL_HOURS: GbpTimePeriod[] = [
  {
    openDay: "MONDAY",
    openTime: { hours: 8 },
    closeDay: "MONDAY",
    closeTime: { hours: 17 },
  },
  {
    openDay: "TUESDAY",
    openTime: { hours: 8 },
    closeDay: "TUESDAY",
    closeTime: { hours: 17 },
  },
  {
    openDay: "WEDNESDAY",
    openTime: { hours: 8 },
    closeDay: "WEDNESDAY",
    closeTime: { hours: 17 },
  },
  {
    openDay: "THURSDAY",
    openTime: { hours: 8 },
    closeDay: "THURSDAY",
    closeTime: { hours: 19 },
  },
  {
    openDay: "FRIDAY",
    openTime: { hours: 8 },
    closeDay: "FRIDAY",
    closeTime: { hours: 14 },
  },
];

const FIRST_NAMES = [
  "Maria",
  "James",
  "Aisha",
  "Tom",
  "Priya",
  "Derek",
  "Hannah",
  "Luis",
  "Grace",
  "Kevin",
  "Simone",
  "Brad",
  "Elena",
  "Marcus",
  "Jenny",
  "Omar",
  "Kate",
  "Victor",
  "Nadia",
  "Paul",
  "Renee",
  "Scott",
  "Ingrid",
  "Dave",
] as const;

const LAST_NAMES = [
  "Gutierrez",
  "Okafor",
  "Lindqvist",
  "Patterson",
  "Shah",
  "Kowalski",
  "Tran",
  "Bennett",
  "Marsh",
  "Delgado",
  "Novak",
  "Ferris",
  "Huang",
  "Osei",
  "Brandt",
  "Kelley",
  "Ivanov",
  "McAllister",
  "Roy",
  "Sandoval",
] as const;

const POSITIVE_COMMENTS = [
  "Best cleaning I've ever had. The hygienist was gentle and explained everything as she went.",
  "Dr. Patel fixed my chipped front tooth in one visit and it looks perfect. Couldn't be happier.",
  "Front desk got me in same-day for a broken crown. Everyone was kind and the billing was exactly what they quoted.",
  "I've been terrified of dentists my whole life and this is the first office that made me feel at ease.",
  "They took my kids (4 and 7) for their first checkups — patient, funny, zero tears. We found our family dentist.",
  "Painless root canal. Never thought I'd type those words.",
  "Super clean office, on time, and they actually explain your x-rays instead of rushing you out.",
  "The whole team remembered my name on the second visit. Little things like that matter.",
  "Invisalign consult was honest — they told me I didn't need it yet and gave me cheaper options first.",
  "In and out in 45 minutes for a filling, numb the whole time, no lecture. Great experience.",
  "My hygienist Kelsey is the reason I actually keep my six-month appointments now.",
  "Emergency visit on a Friday afternoon for my son's cracked molar — they stayed late for us.",
] as const;

const NEUTRAL_COMMENTS = [
  "Cleaning was fine, but I waited about 25 minutes past my appointment time.",
  "Good dentist, average front office. Booking by phone takes forever — wish they had online scheduling.",
  "The work itself was solid. Parking downtown is a pain, plan extra time.",
  "Decent visit overall. The upsell on whitening at the end felt unnecessary.",
] as const;

const NEGATIVE_COMMENTS = [
  "Quoted one price at the desk and billed my insurance for something else. Still untangling it a month later.",
  "Waited 50 minutes and then the appointment felt rushed. Not coming back.",
  "The filling they did last spring already fell out. Getting it redone elsewhere.",
  "Impossible to reach by phone. Left three voicemails about a billing question, no call back.",
  "Hygienist was rough and dismissive when I said it hurt. Really disappointing after the good reviews.",
] as const;

const EDIT_ADDENDA = [
  "the office called me the next day and sorted everything out, bumping this up.",
  "still feeling great two months later.",
  "downgrading — the second visit didn't live up to the first.",
  "adding a star since they fixed the billing mix-up quickly.",
] as const;

const OWNER_REPLIES_POSITIVE = [
  "Thank you so much for the kind words! We'll pass this along to the whole team — see you at your next checkup.",
  "We're so glad you had a great visit! Thanks for trusting us with your smile.",
  "Thank you! Making nervous patients comfortable is exactly what we aim for.",
  "Thanks for bringing the kids in — we love being a family practice. See you all in six months!",
] as const;

const OWNER_REPLIES_NEGATIVE = [
  "We're sorry your visit fell short. Please call our office manager at the front desk number so we can make this right.",
  "Thank you for the honest feedback — we've reviewed our scheduling that week and are making changes so waits like this don't happen again.",
  "We apologize for the billing confusion. Our manager has reached out to help resolve the insurance claim.",
] as const;
