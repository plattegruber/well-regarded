import type { Route } from "./+types/healthz";

/**
 * Resource route (loader only, no component) for deploy verification —
 * Epic #2's pipeline curls this after `wrangler deploy`. `GIT_SHA` is a
 * deploy-time var injected by that pipeline (see app/types.ts); locally it
 * is absent and the route reports "dev".
 */
export function loader({ context }: Route.LoaderArgs) {
  const env = context.cloudflare.env;
  return Response.json({ ok: true, sha: env.GIT_SHA ?? "dev" });
}
