/**
 * Node-importable barrel for the api worker (the wrangler entrypoint is
 * src/worker.ts — see wrangler.jsonc). Tests and future workspace
 * consumers import from here.
 */

export { app } from "./app";
export type { ApiBindings, AppEnv } from "./bindings";
export { requestId } from "./middleware/requestId";
export { extractOrgClaims, type OrgClaims } from "./middleware/sessionClaims";
export {
  type ForbiddenReason,
  requirePermission,
  staffAuth,
} from "./middleware/staffAuth";
export { withDb } from "./middleware/withDb";
