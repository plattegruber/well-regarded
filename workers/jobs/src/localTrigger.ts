/**
 * Local-only debug endpoint: `POST /__local/trigger/embedding-backfill`
 * with an optional JSON params body creates one instance of the
 * `wr-embedding-backfill` Workflow, so the backfill is drivable under
 * `wrangler dev` (which runs Workflows locally but has no CLI trigger for
 * a dev session). Mirrors the pipeline worker's `/__local/enqueue/<stage>`
 * pattern: hard-gated on `ENVIRONMENT === "local"`, 404 everywhere else.
 *
 * Deployed environments trigger via the Wrangler CLI instead — see
 * docs/embedding-backfill.md.
 */

import { getEnv, jobsEnvSchema } from "@wellregarded/core";

import type { JobsBindings } from "./bindings";

const TRIGGER_PATH = "/__local/trigger/embedding-backfill";

export async function handleLocalTrigger(
  request: Request,
  env: JobsBindings,
): Promise<Response> {
  const vars = getEnv(env, jobsEnvSchema);
  if (vars.ENVIRONMENT !== "local") {
    return new Response("Not found", { status: 404 });
  }

  const { pathname } = new URL(request.url);
  if (pathname !== TRIGGER_PATH || request.method !== "POST") {
    return new Response(
      `Local jobs debug endpoint. POST optional JSON params to ${TRIGGER_PATH}.`,
      { status: pathname === TRIGGER_PATH ? 405 : 404 },
    );
  }

  const workflow = env.EMBEDDING_BACKFILL;
  if (workflow === undefined) {
    return new Response(
      "No EMBEDDING_BACKFILL workflow binding in this environment.",
      { status: 500 },
    );
  }

  // Params are optional; an empty body means "defaults, global sweep".
  let params: unknown;
  const raw = await request.text();
  if (raw.trim().length > 0) {
    try {
      params = JSON.parse(raw);
    } catch {
      return new Response("Body must be JSON (or empty).", { status: 400 });
    }
  }

  const instance = await workflow.create(
    params === undefined ? undefined : { params },
  );
  return Response.json(
    { triggered: "embedding-backfill", instanceId: instance.id },
    { status: 202 },
  );
}
