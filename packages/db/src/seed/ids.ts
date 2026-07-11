/**
 * Deterministic IDs and values for the seed (issue #32 requirement 2).
 *
 * Two runs on two machines must produce the same primary keys — E2E
 * selectors (Epic #25) may reference them. `seedId` derives a stable,
 * UUID-shaped value from a name by hashing it (uuid_generate_v5-style, per
 * the issue), so `seedId("signal:g01")` is the same UUID forever.
 *
 * Pure integer math on purpose: `node:crypto` has no type declarations in
 * this workspace (src/ stays runtime-neutral for Workers), and WebCrypto's
 * digest is async. cyrb128 (a well-known public-domain 128-bit string
 * hash) is deterministic across platforms and more than enough for the
 * ~200 names the seed generates.
 */

/** cyrb128 — four 32-bit lanes of avalanche-mixed hash state. */
function cyrb128(input: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < input.length; i++) {
    const k = input.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

const SEED_ID_NAMESPACE = "wellregarded-demo-seed";

/**
 * A stable, RFC-4122-shaped UUID for a seed entity name, e.g.
 * `seedId("practice:cedar-ridge-dental")`. Same name, same UUID, forever
 * (changing this function is a `SEED_VERSION` bump).
 */
export function seedId(name: string): string {
  const lanes = cyrb128(`${SEED_ID_NAMESPACE}:${name}`);
  const hex = lanes.map((lane) => lane.toString(16).padStart(8, "0")).join("");
  // Stamp the version nibble (4) and variant nibble (8..b) so the value is
  // a well-formed UUID; the remaining 122 bits are the hash.
  const variant = "89ab".charAt(Number.parseInt(hex.charAt(16), 16) % 4);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

/**
 * A deterministic float in [lo, hi], derived from a name — used to vary
 * derivation `confidence` without `Math.random()`. Rounded to 2 decimals
 * so values read like real model output.
 */
export function seededFloat(name: string, lo: number, hi: number): number {
  const [lane] = cyrb128(`${SEED_ID_NAMESPACE}:float:${name}`);
  const unit = lane / 0xffffffff;
  return Math.round((lo + unit * (hi - lo)) * 100) / 100;
}

/** A deterministic integer in [0, bound), derived from a name. */
export function seededInt(name: string, bound: number): number {
  const [, lane] = cyrb128(`${SEED_ID_NAMESPACE}:int:${name}`);
  return lane % bound;
}
