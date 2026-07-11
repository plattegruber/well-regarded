/**
 * Local-only debug endpoint: `POST /__local/enqueue/<stage>` with a JSON
 * body enqueues that body onto the stage's queue, so the pipeline is
 * drivable under `wrangler dev` before any real producer exists (#104/#111
 * land the deployed entry points).
 *
 * Hard-gated on `ENVIRONMENT === "local"` — every other environment (and
 * every other path/method) gets a 404. The body is deliberately NOT
 * validated here: sending garbage is exactly how you exercise the
 * malformed → DLQ path locally.
 */

import { getEnv, PIPELINE_STAGES, pipelineEnvSchema } from "@wellregarded/core";

import type { PipelineBindings, QueueProducer } from "./bindings";

const producerBindingByStage = {
  // INGEST_QUEUE is bound only in the local wrangler block (see bindings.ts).
  ingest: "INGEST_QUEUE",
  dedupe: "DEDUPE_QUEUE",
  classify: "CLASSIFY_QUEUE",
  route: "ROUTE_QUEUE",
} as const;

const PATH_PATTERN = new RegExp(
  `^/__local/enqueue/(${PIPELINE_STAGES.join("|")})$`,
);

export async function handleLocalEnqueue(
  request: Request,
  env: PipelineBindings,
): Promise<Response> {
  const vars = getEnv(env, pipelineEnvSchema);
  if (vars.ENVIRONMENT !== "local") {
    return new Response("Not found", { status: 404 });
  }

  const match = PATH_PATTERN.exec(new URL(request.url).pathname);
  if (match === null || request.method !== "POST") {
    return new Response(
      `Local pipeline debug endpoint. POST a JSON body to /__local/enqueue/<stage> (stage: ${PIPELINE_STAGES.join(", ")}).`,
      { status: match === null ? 404 : 405 },
    );
  }

  const stage = match[1] as (typeof PIPELINE_STAGES)[number];
  const producer = env[producerBindingByStage[stage]] as
    | QueueProducer
    | undefined;
  if (producer === undefined) {
    return new Response(
      `No producer binding for stage "${stage}" in this environment.`,
      { status: 500 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("Body must be JSON.", { status: 400 });
  }

  await producer.send(body);
  return Response.json({ queued: stage }, { status: 202 });
}
