/**
 * The dev-only PII keyring the seed encrypts contact points with.
 *
 * These are the SAME committed dev values as every `.dev.vars.example`
 * (`PII_ENCRYPTION_KEYS` / `PII_HASH_KEY`) — safe to commit because they
 * never protect real data, and aligned so a locally running worker can
 * decrypt what the seed wrote. NEVER a production key: the CLI refuses to
 * run when `ENVIRONMENT=prod` (see `./guard.ts`), and real environments
 * get their keyring from Wrangler secrets, not from source.
 *
 * If a `PII_ENCRYPTION_KEYS`/`PII_HASH_KEY` pair is present in the
 * environment (e.g. a developer who rotated their local keys), the CLI
 * prefers it via `keyringFromEnv` — see `./cli.ts`.
 */

import { createKeyring, type Keyring } from "@wellregarded/core";

/** Mirrors `PII_ENCRYPTION_KEYS` in `.dev.vars.example` — dev-only. */
export const DEV_PII_ENCRYPTION_KEYS: Record<string, string> = {
  "1": "JB0/YtR2n0wh265yN8SRYBs45Lp0yt7sE2m+Ty6LOaE=",
};

/** Mirrors `PII_HASH_KEY` in `.dev.vars.example` — dev-only. */
export const DEV_PII_HASH_KEY = "JKTMICa0vU/Ori8626X0AqH4D+At4aJ3cPg5JQBKqwI=";

/** Build the dev keyring (cached `CryptoKey`s live inside the object). */
export function devKeyring(): Keyring {
  return createKeyring({
    encryptionKeys: DEV_PII_ENCRYPTION_KEYS,
    hashKey: DEV_PII_HASH_KEY,
  });
}
