/**
 * Content hashing for the dedupe stage's exact path (issue #106): sha256
 * over a signal's (text, rating, occurredAt) triple, so "did this re-import
 * change anything?" is one string comparison.
 *
 * The fields are JSON-encoded as a tuple before hashing — an unambiguous
 * framing (null vs empty string vs a literal separator character in review
 * text can never collide). Rating enters in its canonical `numeric(2,1)`
 * string form ("4.0"), occurredAt as the ISO instant, so both sides of a
 * comparison hash the exact representation Postgres stores.
 */

export interface HashableContent {
  text: string | null;
  /** Canonical rating string (see canonicalizeRating in ../normalize/rating). */
  rating: string | null;
  occurredAt: Date;
}

/** sha256 hex of the canonical content encoding (WebCrypto — workerd + Node). */
export async function contentHash(content: HashableContent): Promise<string> {
  const encoded = new TextEncoder().encode(
    JSON.stringify([
      content.text,
      content.rating,
      content.occurredAt.toISOString(),
    ]),
  );
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
