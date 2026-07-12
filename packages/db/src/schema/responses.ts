/**
 * `responses` — public-review reply drafts and their approval/publish
 * lifecycle (issues #80/#82, Epic #10).
 *
 * One row per drafted reply to a public-review signal. `status` is the
 * issue-#80 state machine (`draft → pending_approval → approved →
 * published | failed`, reject loops back to `draft`), decided ONLY by
 * `canTransition` in `@wellregarded/core` and written ONLY by
 * `transitionResponse` in ../queries/responses.ts — a guarded
 * `UPDATE … WHERE status = <from>` plus an `audit_log` row in one
 * transaction. No other code path may write `status`.
 *
 * Publish-outcome columns (issue #82, the #127 seam contract):
 *
 * - `published_at` + `publish_update_time` — set on `published`. Per the
 *   #117 spike, "published" means ACCEPTED BY GOOGLE, not live:
 *   `moderation_state` records the reply's moderation state (`PENDING` on
 *   a fresh reply; the async PENDING → APPROVED/REJECTED flip arrives via
 *   the #123 poller / #125 adapter).
 * - `error_detail` — set on `failed`: the persisted `ResponseErrorDetail`
 *   (the `replyErrorDetail` contract, plus the synchronous
 *   `moderation_rejected` outcome). Rendered on the review detail and the
 *   Today screen; cleared when a manual retry re-approves.
 * - `rejection_comment` — the latest "changes requested" comment from a
 *   reject; shown in the composer when the draft comes back.
 *
 * Multiple rows per signal are legal (the #77 thread renders the history);
 * the composer (#79) owns which draft is "current".
 */

import type {
  ResponseErrorDetail,
  ResponseModerationState,
  ResponseOrigin,
} from "@wellregarded/core";
import { RESPONSE_STATUSES } from "@wellregarded/core";
import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { signals } from "./signals.js";
import { practices, staffMembers } from "./tenancy.js";

// Enum values sourced from @wellregarded/core — the state machine and this
// column can never disagree on the vocabulary.
export const responseStatusEnum = pgEnum("response_status", RESPONSE_STATUSES);

export const responses = pgTable(
  "responses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    /** The public-review signal being replied to. */
    signalId: uuid("signal_id")
      .notNull()
      .references(() => signals.id),
    /**
     * The draft's author — the self-approval rules key off this. NULLABLE
     * for #214's source-imported rows only (pre-existing Google replies
     * have no staff author); every dashboard-origin row has one.
     */
    authorId: uuid("author_id").references(() => staffMembers.id),
    /**
     * `dashboard` (the #80 workflow) vs `source_import` (#214, reserved) —
     * see `RESPONSE_ORIGINS` in @wellregarded/core.
     */
    origin: text("origin")
      .$type<ResponseOrigin>()
      .notNull()
      .default("dashboard"),

    status: responseStatusEnum("status").notNull().default("draft"),
    /** The reply text (≤ 4096 UTF-8 bytes at publish; #79 enforces earlier). */
    body: text("body").notNull(),

    /** Latest reject comment ("Changes requested: …"); null once resubmitted. */
    rejectionComment: text("rejection_comment"),

    // Publish outcome (issue #82) — see the module doc.
    errorDetail: jsonb("error_detail").$type<ResponseErrorDetail>(),
    moderationState: text("moderation_state").$type<ResponseModerationState>(),
    /** Google's rejection reason, when `moderation_state` is REJECTED. */
    policyViolation: text("policy_violation"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    /** The reply's `updateTime` as Google recorded it — the canonical ref. */
    publishUpdateTime: text("publish_update_time"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The #77 thread: all responses for one signal, newest first.
    index("responses_signal_id_created_at_idx").on(
      table.signalId,
      table.createdAt.desc(),
    ),
    // The approval queue badge (#80) and failed-publish Today card (#82):
    // practice-scoped status scans.
    index("responses_practice_id_status_idx").on(
      table.practiceId,
      table.status,
    ),
    // #214's structural idempotency guard: a signal has AT MOST ONE
    // source-imported response row — re-polls and the backfill update it
    // in place (`upsertImportedResponse`), they never stack duplicates.
    // Dashboard-origin rows are untouched (multiple drafts stay legal).
    uniqueIndex("responses_signal_id_source_import_uniq")
      .on(table.signalId)
      .where(sql`${table.origin} = 'source_import'`),
  ],
);
