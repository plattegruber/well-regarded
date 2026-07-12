import {
  index,
  layout,
  type RouteConfig,
  route,
} from "@react-router/dev/routes";

export default [
  // App shell (#115) wraps all product routes: the nine surfaces (#132),
  // the reference CRUD page (#141), and the catch-all 404.
  layout("routes/shell.tsx", [
    // "/" redirects to /today — the queue is the front door.
    index("routes/home.tsx"),
    route("today", "routes/today.tsx"),
    route("signals", "routes/signals.tsx"),
    // Signal detail (#90): provenance, derivations, consent, related items.
    route("signals/:signalId", "routes/signals.$signalId.tsx"),
    route("reviews", "routes/reviews.tsx"),
    route("recovery", "routes/recovery.tsx"),
    route("proof", "routes/proof.tsx"),
    route("coverage", "routes/coverage.tsx"),
    route("insights", "routes/insights.tsx"),
    route("presence", "routes/presence.tsx"),
    route("settings", "routes/settings.tsx"),
    // Reference CRUD page (#141) — the "action recipe" every later
    // mutation copies. Not nested under settings.tsx: the section list is
    // an index of pages, not a layout.
    route("settings/practice", "routes/settings.practice.tsx"),
    // CSV import entry point (#133): upload + hand-off to the mapping
    // wizard (#134). Same non-nested placement rationale as above.
    route("settings/imports", "routes/settings.imports.tsx"),
    // Integrations (#121): the Google Business Profile connection card and
    // the location-mapping screen. The mapping route is reachable both
    // mid-onboarding (right after the OAuth callback) and later from
    // settings — no special flags, by design.
    route("settings/integrations", "routes/settings.integrations.tsx"),
    route(
      "settings/integrations/google/locations",
      "routes/settings.integrations.google.locations.tsx",
    ),
    // Dev-only design-system reference; its loader 404s in production.
    route("styleguide", "routes/styleguide.tsx"),
  ]),
  // Resource route (no component): deploy verification, curled by Epic #2.
  route("healthz", "routes/healthz.ts"),
  // Anything unmatched 404s through the root ErrorBoundary (#141).
  route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
