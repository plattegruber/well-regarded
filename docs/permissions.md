# Permissions

<!-- Generated from `packages/core/src/permissions/matrix.ts` by `pnpm gen:docs`. Do not edit by hand — edit the matrix and regenerate. A unit test fails when this file is stale. -->

Who may do what, per staff role. The single source of truth is the
`PERMISSION_MATRIX` data in `@wellregarded/core`, consulted everywhere via
the pure `can(actor, action, resource)` function — dashboard loaders and
actions, Hono API middleware, and (in rendered-disabled form) UI.

| action | owner | office_manager | front_desk | marketing | provider | multi_location_admin | external_partner |
| --- | --- | --- | --- | --- | --- | --- | --- |
| view_patient_identity | allow | allow | scoped | deny | deny | allow | deny |
| view_private_feedback | allow | allow | scoped | allow | scoped | allow | deny |
| assign_recovery | allow | allow | scoped | deny | deny | allow | deny |
| resolve_duplicates | allow | allow | scoped | deny | deny | allow | deny |
| draft_response | allow | allow | scoped | allow | deny | allow | allow |
| approve_response | allow | allow | deny | deny | deny | allow | deny |
| publish_public | allow | allow | deny | allow | deny | allow | deny |
| manage_consent | allow | allow | scoped | deny | deny | allow | deny |
| edit_profile_data | allow | allow | deny | allow | deny | allow | allow |
| manage_settings | allow | allow | deny | deny | deny | allow | deny |
| view_reports | allow | allow | deny | allow | scoped | allow | allow |
| manage_api_keys | allow | deny | deny | deny | deny | deny | deny |

## Legend

- **allow** — permitted anywhere within the actor's practice.
- **deny** — never permitted.
- **scoped** — permitted only within the actor's location scope: an unscoped
  actor (`locationId: null`) may act practice-wide; a location-scoped actor
  may act on practice-wide resources (no `locationId`) or on resources at
  their own location, and nowhere else.

Regardless of role, actions across practices are always denied
(`actor.practiceId` must match `resource.practiceId`).
