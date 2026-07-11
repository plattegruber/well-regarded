import type { StageHandler } from "./types";

/**
 * Classify stage — consumer of `wr-classify`.
 *
 * Scaffold (issue #98): log and return (the dispatcher acks). The real
 * implementation (#108; prompts are Epic #9) re-reads the `signals` row,
 * classifies via `packages/ai` (zod-validated structured output), writes
 * `derivations` rows, and enqueues a RouteMessage on `env.ROUTE_QUEUE`.
 */
export const classify: StageHandler<"classify"> = async (message, _env) => {
  console.log(
    JSON.stringify({
      event: "pipeline.stage.stub",
      stage: "classify",
      signalId: message.signalId,
      practiceId: message.practiceId,
      importRunId: message.importRunId,
    }),
  );
};
