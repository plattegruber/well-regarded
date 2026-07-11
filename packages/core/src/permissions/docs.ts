import { STAFF_ROLES } from "../staff.js";
import { ACTIONS } from "./actions.js";
import { PERMISSION_MATRIX } from "./matrix.js";

/**
 * Renders `docs/permissions.md` from the permission matrix data, so the
 * documentation cannot drift from the code. `scripts/generate-permissions-doc.ts`
 * writes this to disk (`pnpm gen:docs`); a unit test asserts the committed
 * file matches this output, failing CI when it goes stale.
 */
export function renderPermissionsDoc(): string {
  const header = ["action", ...STAFF_ROLES];
  const separator = header.map(() => "---");
  const rows = ACTIONS.map((action) => [
    action,
    ...STAFF_ROLES.map((role) => PERMISSION_MATRIX[role][action]),
  ]);

  const toRow = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
  const table = [header, separator, ...rows].map(toRow).join("\n");

  return `# Permissions

<!-- Generated from \`packages/core/src/permissions/matrix.ts\` by \`pnpm gen:docs\`. Do not edit by hand — edit the matrix and regenerate. A unit test fails when this file is stale. -->

Who may do what, per staff role. The single source of truth is the
\`PERMISSION_MATRIX\` data in \`@wellregarded/core\`, consulted everywhere via
the pure \`can(actor, action, resource)\` function — dashboard loaders and
actions, Hono API middleware, and (in rendered-disabled form) UI.

${table}

## Legend

- **allow** — permitted anywhere within the actor's practice.
- **deny** — never permitted.
- **scoped** — permitted only within the actor's location scope: an unscoped
  actor (\`locationId: null\`) may act practice-wide; a location-scoped actor
  may act on practice-wide resources (no \`locationId\`) or on resources at
  their own location, and nowhere else.

Regardless of role, actions across practices are always denied
(\`actor.practiceId\` must match \`resource.practiceId\`).
`;
}
