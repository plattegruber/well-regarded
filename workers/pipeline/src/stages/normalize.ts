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
  console.log(
    JSON.stringify({
      event: "pipeline.stage.stub",
      stage: "ingest",
      importRunId: message.importRunId,
      practiceId: message.practiceId,
      rawArtifactKey: message.rawArtifactKey,
      sourceKind: message.sourceKind,
    }),
  );
};
