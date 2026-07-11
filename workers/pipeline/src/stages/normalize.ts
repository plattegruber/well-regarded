import { createLogger } from "@wellregarded/core";

import type { StageHandler } from "./types";

/**
 * Normalize stage — consumer of `wr-ingest`.
 *
 * Scaffold (issue #98): the message arrives already validated by the
 * dispatcher; log and return (the dispatcher acks). The real implementation
 * (#104) reads the raw artifact from R2, maps it into canonical `signals`
 * rows via the source adapter (`packages/sources`), and enqueues a
 * DedupeMessage per signal on `env.DEDUPE_QUEUE`.
 */
export const normalize: StageHandler<"ingest"> = async (message, _env) => {
  createLogger({
    worker: "pipeline",
    requestId: message.requestId,
    practiceId: message.practiceId,
    stage: "ingest",
  }).info("pipeline.stage.stub", {
    importRunId: message.importRunId,
    rawArtifactKey: message.rawArtifactKey,
    sourceKind: message.sourceKind,
  });
};
