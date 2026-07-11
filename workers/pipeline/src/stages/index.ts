import type { PipelineStage } from "@wellregarded/core";

import { classify } from "./classify";
import { dedupe } from "./dedupe";
import { normalize } from "./normalize";
import { route } from "./route";
import type { StageHandler } from "./types";

export { handleDlqMessage } from "./dlq";
export type { StageHandler } from "./types";

/**
 * The per-stage handler each main queue dispatches to. The map's value types
 * are stage-specific (`StageHandler<S>`), so a handler can only ever see its
 * own message shape.
 */
export const stageHandlers: {
  [S in PipelineStage]: StageHandler<S>;
} = {
  ingest: normalize,
  dedupe,
  classify,
  route,
};
