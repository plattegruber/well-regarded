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
  console.log(
    JSON.stringify({
      event: "pipeline.stage.stub",
      stage: "dedupe",
      signalId: message.signalId,
      practiceId: message.practiceId,
      importRunId: message.importRunId,
    }),
  );
};
