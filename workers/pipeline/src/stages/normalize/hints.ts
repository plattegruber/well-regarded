/**
 * Entity-hint resolution policy for the normalize stage (issue #104,
 * requirement 3) — pure functions, unit-testable without Miniflare.
 *
 * "Confident" is defined narrowly and deliberately: an exact
 * case/whitespace-insensitive match on the entity's name (or, for
 * providers, full name). Nothing fuzzier lives in this issue — a near-miss
 * stays a stored hint (text + basis) and NEVER becomes a guessed FK.
 */

import type { EntityHint } from "@wellregarded/sources";

/** The name surface of a practice entity (provider or location). */
export interface NamedEntity {
  id: string;
  /** All names the entity answers to (e.g. display name + full name). */
  names: Array<string | null>;
}

/** Exact-match key: case-insensitive, whitespace-collapsed. */
export function normalizeEntityName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface HintResolution {
  /** Set only on a confident match. */
  entityId: string | null;
  /** The hint to persist when no confident match exists. */
  hint: EntityHint | null;
}

/**
 * Resolve one hint against the practice's entities. Confident = exactly one
 * entity whose (normalized) name equals the (normalized) hint text; an
 * ambiguous match (two providers sharing a display name) is NOT confident
 * and keeps the hint.
 */
export function resolveEntityHint(
  hint: EntityHint | undefined,
  entities: NamedEntity[],
): HintResolution {
  if (hint === undefined) return { entityId: null, hint: null };

  const wanted = normalizeEntityName(hint.text);
  const matches = entities.filter((entity) =>
    entity.names.some(
      (name) => name !== null && normalizeEntityName(name) === wanted,
    ),
  );
  if (matches.length === 1 && matches[0] !== undefined) {
    return { entityId: matches[0].id, hint: null };
  }
  return { entityId: null, hint };
}
