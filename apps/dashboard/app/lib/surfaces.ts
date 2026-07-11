// The nine surfaces' static metadata — the copy table from #132, exported
// once so the route files and the render tests share a single source.
//
// Header copy (overline, title, description) follows the imported mockup
// (design/well-regarded-dashboard.dc.html) — each screen opens with a mono
// overline, a 32px h1, and a quiet subhead. Empty-state copy is the table
// from issue #132, adapted only where it broke the design system's voice
// rules (sentence case: "Patient Proof" → "Patient proof", "Trust
// Coverage" → "Trust coverage" mid-sentence).
//
// Later issues replace each route's loader with real data; this table then
// shrinks to the copy that survives (empty states, meta titles).
import type { LucideIcon } from "lucide-react";

import { NAV_ITEMS, SETTINGS_ITEM } from "~/components/shell/nav";

export interface SurfaceEmptyState {
  heading: string;
  body: string;
  /** Optional action, rendered disabled with a "Coming soon" tooltip. */
  action?: { label: string; comingSoon: true };
}

export interface Surface {
  path: string;
  /** Sidebar label; also the meta-title segment. */
  label: string;
  /** Mono overline above the h1. `/today` overrides this with the date. */
  overline: string;
  /** The 32px h1. */
  title: string;
  /** One quiet sentence under the title. */
  description: string;
  /** Null for /settings, which renders a section list instead. */
  empty: SurfaceEmptyState | null;
}

export const SURFACES = {
  today: {
    path: "/today",
    label: "Today",
    overline: "Today", // replaced by the formatted date in the loader
    title: "Good morning",
    description:
      "Your practice is already well regarded. Here is what needs you, and what does not.",
    empty: {
      heading: "Nothing needs your attention",
      body: "Today is a queue, not a dashboard. Urgent concerns, overdue recovery items, and responses waiting for approval appear here the moment they exist — an empty page means you're caught up.",
    },
  },
  signals: {
    path: "/signals",
    label: "Signals",
    overline: "Trust signals · unified inbox",
    title: "Signals",
    description:
      "Every legitimate piece of patient evidence, public or private, with its source and rights preserved.",
    empty: {
      heading: "No signals yet",
      body: "Every piece of patient feedback — Google reviews, imported surveys, notes your team records — lands here as one searchable timeline, with its source and context attached. Connect a source or import a file to see your first signals.",
      action: { label: "Import feedback", comingSoon: true },
    },
  },
  reviews: {
    path: "/reviews",
    label: "Reviews",
    overline: "Public reviews · response workspace",
    title: "Reviews",
    description:
      "Respond safely and promptly. Public replies need your approval by default.",
    empty: {
      heading: "No public reviews yet",
      body: "Public reviews appear here with suggested responses that are checked for privacy before you ever see them. Nothing is published without a person approving it.",
    },
  },
  recovery: {
    path: "/recovery",
    label: "Recovery",
    overline: "Service recovery · operational queue",
    title: "Recovery",
    description:
      "Concerns become work, not just reputational risk. Items stay open until resolved.",
    empty: {
      heading: "No open concerns",
      body: "When feedback suggests an unhappy patient, it becomes a recovery item with an owner, a due date, and a contact log. The goal is always to address the concern — never to chase a rating.",
    },
  },
  proof: {
    path: "/proof",
    label: "Patient proof",
    overline: "Patient proof · governed library",
    title: "Patient proof",
    description:
      "Authentic evidence with provenance and consent tracked. Nothing is published until rights are explicit.",
    empty: {
      heading: "Your proof library is empty",
      body: "Patient proof is the inventory of feedback you have explicit consent to reuse — on your website, in the office, and beyond. Every item shows its consent status, and nothing is published without one.",
    },
  },
  coverage: {
    path: "/coverage",
    label: "Trust coverage",
    overline: "Trust coverage · where confidence is missing",
    title: "Trust coverage",
    description:
      "A 4.8 rating can still hide gaps. This is whether future patients have credible, current evidence for the decisions they make.",
    empty: {
      heading: "Coverage will appear once you have proof",
      body: "Trust coverage shows where patients are looking for evidence you don't have yet — a service with no recent story, a provider no one has written about. Recommendations always come with the evidence behind them.",
    },
  },
  insights: {
    path: "/insights",
    label: "Insights",
    overline: "Practice intelligence",
    title: "Insights",
    description:
      "What patients consistently value, what is shifting, and where it is concentrated.",
    empty: {
      heading: "No insights yet",
      body: "Insights explains what's changing and why in plain language — recurring themes, trends, and a weekly brief built only from numbers we actually measured. It starts working once signals arrive.",
    },
  },
  presence: {
    path: "/presence",
    label: "Presence",
    overline: "Public-presence health",
    title: "Presence",
    description:
      "Reputation weakens when public information is inaccurate or stale. These are the surfaces that affect patient action.",
    empty: {
      heading: "Presence is not watching anything yet",
      body: "Presence keeps an eye on the public profiles patients actually see — hours, links, photos, categories — and flags unexpected changes or broken details before patients notice. Connect your Google Business Profile to start.",
      action: { label: "Connect Google", comingSoon: true },
    },
  },
  settings: {
    path: "/settings",
    label: "Settings",
    overline: "Practice configuration",
    title: "Settings",
    description:
      "Profile, locations, people, and integrations — the practice as Well Regarded knows it.",
    empty: null,
  },
} as const satisfies Record<string, Surface>;

export type SurfaceKey = keyof typeof SURFACES;

/** Browser-tab title: "<Surface> · Well Regarded". */
export function surfaceTitle(surface: Surface): string {
  return `${surface.label} · Well Regarded`;
}

/**
 * The surface's sidebar icon, looked up from the nav contract so the empty
 * state can never drift from the sidebar (#132 requires they match).
 */
export function surfaceIcon(surface: Surface): LucideIcon {
  const item = [...NAV_ITEMS, SETTINGS_ITEM].find(
    (candidate) => candidate.to === surface.path,
  );
  if (!item) {
    throw new Error(`No nav item for surface ${surface.path}`);
  }
  return item.icon;
}

/**
 * /today's overline is the date, per the mockup ("Tuesday, July 8").
 * Rendered in UTC until practices carry a wired timezone — the loader
 * replaces this once Today has real data.
 */
export function todayOverline(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(now);
}
