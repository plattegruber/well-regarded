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
    // Manual single-signal entry (#138). Registered before the dynamic
    // detail route for readability; React Router ranks the static segment
    // higher regardless.
    route("signals/new", "routes/signals.new.tsx"),
    // Signal detail (#90): provenance, derivations, consent, related items.
    route("signals/:signalId", "routes/signals.$signalId.tsx"),
    route("reviews", "routes/reviews.tsx"),
    // Review detail (#77): honest derivations, attribution, response seam.
    route("reviews/:signalId", "routes/reviews.$signalId.tsx"),
    // Response workflow (#80/#82): the thread + approve/reject/retry
    // ACTION endpoint for one review, plus a minimal standalone page. The
    // detail page above mounts the same components (via ResponseThreadSlot)
    // and posts here — see the route header's integration contract.
    route(
      "reviews/:signalId/responses",
      "routes/reviews.$signalId.responses.tsx",
    ),
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
    // AI configuration (#75): kill switch + monthly budget, owner-gated.
    route("settings/ai", "routes/settings.ai.tsx"),
    // Imports list (#137): the practice's import runs, with the "New
    // import" entry point. Same non-nested placement rationale as above.
    route("settings/imports", "routes/settings.imports.tsx"),
    // CSV import entry point (#133): upload + hand-off to the mapping
    // wizard (#134). Static segment, so it outranks :draftId below.
    route("settings/imports/new", "routes/settings.imports.new.tsx"),
    // Import report (#137): counts, error table, failures CSV, duplicates.
    // Under the static "runs" segment so run ids can never collide with
    // the wizard's :draftId at the same path position.
    route(
      "settings/imports/runs/:importRunId",
      "routes/settings.imports.runs.$importRunId.tsx",
    ),
    // Column-mapping wizard (#134): one nested route per step so the
    // browser back button walks the steps, and an index that resumes from
    // the draft's saved wizard_step.
    route("settings/imports/:draftId", "routes/settings.imports.$draftId.tsx", [
      index("routes/settings.imports.$draftId._index.tsx"),
      route("map", "routes/settings.imports.$draftId.map.tsx"),
      route("validate", "routes/settings.imports.$draftId.validate.tsx"),
      route("consent", "routes/settings.imports.$draftId.consent.tsx"),
      route("confirm", "routes/settings.imports.$draftId.confirm.tsx"),
    ]),
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
