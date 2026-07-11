import { createLogger } from "@wellregarded/core";

import type { StageHandler } from "./types";

/**
 * Dedupe stage — consumer of `wr-dedupe`.
 *
 * Scaffold (issue #98): log and return (the dispatcher acks). The real
 * implementation (#106) re-reads the `signals` row, runs exact-hash plus
 * embedding-candidate fuzzy matching (no silent merges), and enqueues a
 * ClassifyMessage on `env.CLASSIFY_QUEUE` for survivors.
 */
export const dedupe: StageHandler<"dedupe"> = async (message, _env) => {
  createLogger({
    worker: "pipeline",
    requestId: message.requestId,
    practiceId: message.practiceId,
    stage: "dedupe",
  }).info("pipeline.stage.stub", {
    signalId: message.signalId,
    importRunId: message.importRunId,
  });
};
