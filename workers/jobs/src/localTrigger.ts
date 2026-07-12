/**
 * Local-only debug endpoints: `POST /__local/trigger/<workflow>` with an
 * optional JSON params body creates one instance of the named Workflow,
 * so each is drivable under `wrangler dev` (which runs Workflows locally
 * but has no CLI trigger for a dev session). Mirrors the pipeline
 * worker's `/__local/enqueue/<stage>` pattern: hard-gated on
 * `ENVIRONMENT === "local"`, 404 everywhere else.
 *
 * Deployed environments trigger differently — the backfills (embedding
 * #71, reply-import #214) via the Wrangler CLI (`npx wrangler workflows
 * trigger wr-<name>-<env> '{...}'` — see docs/embedding-backfill.md for
 * the pattern); the CSV import via #134's
 * `POST /imports/csv/:draftId/start` endpoint (docs/csv-import.md).
 */

import { getEnv, jobsEnvSchema } from "@wellregarded/core";

import type { JobsBindings, WorkflowBinding } from "./bindings";

const TRIGGER_PREFIX = "/__local/trigger/";

/** Trigger slug → the Workflow binding it creates an instance of. */
const WORKFLOW_TRIGGERS: Record<string, keyof JobsBindings & string> = {
  "embedding-backfill": "EMBEDDING_BACKFILL",
  "csv-import": "CSV_IMPORT",
  "reply-import-backfill": "REPLY_IMPORT_BACKFILL",
};

export async function handleLocalTrigger(
  request: Request,
  env: JobsBindings,
): Promise<Response> {
  const vars = getEnv(env, jobsEnvSchema);
  if (vars.ENVIRONMENT !== "local") {
    return new Response("Not found", { status: 404 });
  }

  const { pathname } = new URL(request.url);
  if (!pathname.startsWith(TRIGGER_PREFIX)) {
    return new Response(
      `Local jobs debug endpoint. POST optional JSON params to ${TRIGGER_PREFIX}<workflow> ` +
        `(one of: ${Object.keys(WORKFLOW_TRIGGERS).join(", ")}).`,
      { status: 404 },
    );
  }
  const slug = pathname.slice(TRIGGER_PREFIX.length);
  const bindingName = WORKFLOW_TRIGGERS[slug];
  if (bindingName === undefined) {
    return new Response(
      `Unknown workflow "${slug}". Known triggers: ${Object.keys(WORKFLOW_TRIGGERS).join(", ")}.`,
      { status: 404 },
    );
  }
  if (request.method !== "POST") {
    return new Response(`POST optional JSON params to ${pathname}.`, {
      status: 405,
    });
  }

  const workflow = env[bindingName] as WorkflowBinding | undefined;
  if (workflow === undefined) {
    return new Response(
      `No ${bindingName} workflow binding in this environment.`,
      { status: 500 },
    );
  }

  // Params are optional; an empty body means "the workflow's defaults".
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
    { triggered: slug, instanceId: instance.id },
    { status: 202 },
  );
}
