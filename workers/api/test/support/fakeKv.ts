/**
 * In-memory stand-in for the OAUTH_STATE KV binding (issue #118). Honors
 * `expirationTtl` against the real clock and exposes the backing map so
 * tests can inspect or tamper with stored records (e.g. corrupt the PKCE
 * verifier to prove the fake Google rejects the exchange).
 */

export class FakeKv {
  readonly entries = new Map<string, { value: string; expiresAtMs?: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs !== undefined && entry.expiresAtMs <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    this.entries.set(key, {
      value,
      ...(options?.expirationTtl !== undefined
        ? { expiresAtMs: Date.now() + options.expirationTtl * 1000 }
        : {}),
    });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  /** The single stored key, for tests that just started one connect flow. */
  onlyKey(): string {
    const keys = [...this.entries.keys()];
    if (keys.length !== 1 || keys[0] === undefined) {
      throw new Error(`expected exactly one KV entry, found ${keys.length}`);
    }
    return keys[0];
  }
}
