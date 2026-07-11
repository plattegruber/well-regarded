import type { StageHandler } from "./types";

/**
 * Route stage — consumer of `wr-route` (terminal: no next-stage producer).
 *
 * Scaffold (issue #98): log and return (the dispatcher acks). The real
 * implementation (#67, Epic #6) reads the signal's derivations and fans out:
 * high urgency → `recovery_items`; public review → the review inbox;
 * publishable candidate → a proof suggestion (consent-gated downstream).
 */
export const route: StageHandler<"route"> = async (message, _env) => {
  console.log(
    JSON.stringify({
      event: "pipeline.stage.stub",
      stage: "route",
      signalId: message.signalId,
      practiceId: message.practiceId,
      importRunId: message.importRunId,
    }),
  );
};
