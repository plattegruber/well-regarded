/**
 * The demo practice — committed fixture data (issue #32 requirement 4).
 *
 * Matches the designer's mockup (design/README.md, "Demo content the
 * designer chose"): **Cedar Ridge Dental**, two locations (Main Street,
 * North), providers Dr. Aldana, Dr. Patel and Dr. Shah — Shah being the
 * newer associate with thin public evidence — plus a pediatric/hygiene
 * side of the practice (Dr. Kim here). Staff owners mirror the mockup's
 * recovery queue: office manager, front desk, treatment coordinator.
 *
 * SEED CONTRACT: E2E (Epic #25) selects against this data — changing it is
 * a `SEED_VERSION` bump (see `../constants.ts`).
 */

import type { ContactConsentHint, ContactKind } from "@wellregarded/core";

export type LocationKey = "main_street" | "north";
export type ProviderKey = "aldana" | "patel" | "shah" | "kim";
export type StaffKey =
  | "owner_aldana"
  | "office_manager"
  | "front_desk_main"
  | "front_desk_north"
  | "treatment_coordinator";
export type PatientKey =
  | "jordan"
  | "priya"
  | "marcus"
  | "elena"
  | "ruth"
  | "devon"
  | "aiko"
  | "samuel"
  | "gloria"
  | "hannah";

export const DEMO_PRACTICE = {
  name: "Cedar Ridge Dental",
  timezone: "America/Chicago",
  websiteUrl: "https://www.cedarridgedental.example",
  phone: "+1 (555) 014-2200",
} as const;

export interface LocationFixture {
  key: LocationKey;
  name: string;
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
  googlePlaceId: string;
  phone: string;
}

export const LOCATION_FIXTURES: readonly LocationFixture[] = [
  {
    key: "main_street",
    name: "Main Street",
    addressLine1: "412 S Main St",
    city: "Cedar Ridge",
    state: "IL",
    postalCode: "61201",
    googlePlaceId: "demo-place-cedar-ridge-main",
    phone: "+1 (555) 014-2201",
  },
  {
    key: "north",
    name: "North",
    addressLine1: "88 Prairie Crossing Rd",
    city: "Cedar Ridge",
    state: "IL",
    postalCode: "61204",
    googlePlaceId: "demo-place-cedar-ridge-north",
    phone: "+1 (555) 014-2202",
  },
];

export interface ProviderFixture {
  key: ProviderKey;
  displayName: string;
  fullName: string;
  credentials: string;
  location: LocationKey;
  bio: string;
  /** Set when the provider also logs in (`providers.staff_member_id`). */
  staffMember?: StaffKey;
}

export const PROVIDER_FIXTURES: readonly ProviderFixture[] = [
  {
    key: "aldana",
    displayName: "Dr. Aldana",
    fullName: "Lucia Aldana",
    credentials: "DDS",
    location: "main_street",
    bio: "General dentistry. Known for walking anxious patients through every step before touching an instrument.",
    staffMember: "owner_aldana",
  },
  {
    key: "patel",
    displayName: "Dr. Patel",
    fullName: "Anish Patel",
    credentials: "DDS, MS",
    location: "main_street",
    bio: "Implants and restorative dentistry. Fifteen years of placing implants without drama.",
  },
  {
    key: "shah",
    displayName: "Dr. Shah",
    fullName: "Meera Shah",
    credentials: "DMD",
    location: "north",
    // The newer associate with thin public evidence — the product narrative
    // (and the mockup's coverage screen: "Dr. Shah — new · no public
    // proof") depends on her having only recent, mostly-private signals.
    bio: "General dentistry. Joined the practice this spring after residency at UIC.",
  },
  {
    key: "kim",
    displayName: "Dr. Kim",
    fullName: "Grace Kim",
    credentials: "DMD",
    location: "north",
    bio: "Pediatric dentistry. Leads the hygiene program across both locations.",
  },
];

export interface StaffFixture {
  key: StaffKey;
  displayName: string;
  email: string;
  role: "owner" | "office_manager" | "front_desk";
  location?: LocationKey;
}

export const STAFF_FIXTURES: readonly StaffFixture[] = [
  {
    // Dr. Aldana also logs in — her provider row links here via
    // `providers.staff_member_id` (see PROVIDER_FIXTURES).
    key: "owner_aldana",
    displayName: "Lucia Aldana",
    email: "lucia@cedarridgedental.example",
    role: "owner",
  },
  {
    key: "office_manager",
    displayName: "Marisol Vega",
    email: "marisol@cedarridgedental.example",
    role: "office_manager",
  },
  {
    key: "front_desk_main",
    displayName: "Dana Whitfield",
    email: "dana@cedarridgedental.example",
    role: "front_desk",
    location: "main_street",
  },
  {
    key: "front_desk_north",
    displayName: "Tomás Rivera",
    email: "tomas@cedarridgedental.example",
    role: "front_desk",
    location: "north",
  },
  {
    key: "treatment_coordinator",
    displayName: "Renee Caldwell",
    email: "renee@cedarridgedental.example",
    role: "front_desk",
  },
];

export interface ContactPointFixture {
  kind: ContactKind;
  rawValue: string;
  consentHint?: ContactConsentHint;
  /** Days before the anchor the patient opted out, when they did. */
  optedOutDaysAgo?: number;
}

export interface PatientFixture {
  key: PatientKey;
  displayName: string;
  contactPoints: readonly ContactPointFixture[];
}

/**
 * Patients exist for the private-feedback side of the dataset: signals
 * with a `patient_id`, consents granted via patient link, and encrypted
 * contact points (written through `upsertContactPoint`, never raw SQL).
 * "Jordan M." and "Priya S." are the attributions the mockup's proof
 * library shows.
 */
export const PATIENT_FIXTURES: readonly PatientFixture[] = [
  {
    key: "jordan",
    displayName: "Jordan Mercado",
    contactPoints: [
      {
        kind: "email",
        rawValue: "jordan.mercado@example.com",
        consentHint: "explicit",
      },
      { kind: "sms", rawValue: "+15550140021", consentHint: "explicit" },
    ],
  },
  {
    key: "priya",
    displayName: "Priya Shankar",
    contactPoints: [
      {
        kind: "email",
        rawValue: "priya.shankar@example.com",
        consentHint: "implied",
      },
    ],
  },
  {
    key: "marcus",
    displayName: "Marcus Boone",
    contactPoints: [
      { kind: "email", rawValue: "marcus.boone@example.com" },
      // Opted out of SMS — exercises `opted_out_at` for Epic #19's
      // suppression checks.
      { kind: "sms", rawValue: "+15550140022", optedOutDaysAgo: 41 },
    ],
  },
  {
    key: "elena",
    displayName: "Elena Petrov",
    contactPoints: [
      { kind: "sms", rawValue: "+15550140023", consentHint: "implied" },
    ],
  },
  {
    key: "ruth",
    displayName: "Ruth Adler",
    contactPoints: [{ kind: "email", rawValue: "ruth.adler@example.com" }],
  },
  {
    key: "devon",
    displayName: "Devon Hart",
    contactPoints: [
      { kind: "email", rawValue: "devon.hart@example.com" },
      { kind: "sms", rawValue: "+15550140024" },
    ],
  },
  {
    key: "aiko",
    displayName: "Aiko Tanaka",
    contactPoints: [
      {
        kind: "email",
        rawValue: "aiko.tanaka@example.com",
        consentHint: "implied",
      },
    ],
  },
  {
    key: "samuel",
    displayName: "Samuel Ochieng",
    contactPoints: [{ kind: "sms", rawValue: "+15550140025" }],
  },
  {
    key: "gloria",
    displayName: "Gloria Winters",
    contactPoints: [{ kind: "email", rawValue: "gloria.winters@example.com" }],
  },
  {
    key: "hannah",
    displayName: "Hannah Lindqvist",
    contactPoints: [
      {
        kind: "email",
        rawValue: "hannah.lindqvist@example.com",
        consentHint: "explicit",
      },
    ],
  },
];
