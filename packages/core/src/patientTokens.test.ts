import { describe, expect, it } from "vitest";

import {
  createPatientToken,
  MemoryUsedTokenStore,
  TOKEN_TTLS,
  type TokenPurpose,
  type UsedTokenStore,
  verifyPatientToken,
} from "./patientTokens";

/** Base64 of 32 bytes — same shape as `openssl rand -base64 32`. */
const SECRET = "yv66vvrO263eyviIiDNEVBnfQlfIfPUpqkqUgpTjkbA=";
const OTHER_SECRET = "u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7s=";

const NOW = new Date("2026-07-01T00:00:00Z");
const PURPOSES: TokenPurpose[] = [
  "feedback",
  "review_invite",
  "consent",
  "optout",
];

const b64url = {
  decode(text: string): string {
    return atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  },
  encode(text: string): string {
    return btoa(text)
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
  },
};

function mint(purpose: TokenPurpose = "feedback", now: Date = NOW) {
  return createPatientToken(
    { purpose, patientId: "pat_1", practiceId: "prac_1" },
    SECRET,
    now,
  );
}

async function verify(
  token: string,
  overrides: {
    purpose?: TokenPurpose;
    secret?: string;
    store?: UsedTokenStore;
    now?: Date;
  } = {},
) {
  return verifyPatientToken(
    token,
    overrides.purpose ?? "feedback",
    overrides.secret ?? SECRET,
    overrides.store ?? new MemoryUsedTokenStore(),
    overrides.now ?? NOW,
  );
}

/** Re-sign is impossible without the secret, so tampering edits parts raw. */
function withPayload(
  token: string,
  mutate: (claims: Record<string, unknown>) => Record<string, unknown>,
): string {
  const [header, payload, signature] = token.split(".") as [
    string,
    string,
    string,
  ];
  const claims = JSON.parse(b64url.decode(payload));
  return `${header}.${b64url.encode(JSON.stringify(mutate(claims)))}.${signature}`;
}

describe("createPatientToken / verifyPatientToken round-trip", () => {
  it.each(
    PURPOSES,
  )("mints and verifies a %s token with correct claims and TTL", async (purpose) => {
    const token = await mint(purpose);
    const result = await verify(token, { purpose });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.purpose).toBe(purpose);
    expect(result.claims.patient_id).toBe("pat_1");
    expect(result.claims.practice_id).toBe("prac_1");
    expect(result.claims.iat).toBe(Math.floor(NOW.getTime() / 1000));
    expect(result.claims.exp - result.claims.iat).toBe(TOKEN_TTLS[purpose]);
    expect(result.claims.jti).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("gives each token a unique jti", async () => {
    const a = await verify(await mint());
    const b = await verify(await mint());
    if (!a.ok || !b.ok) throw new Error("expected both tokens to verify");
    expect(a.claims.jti).not.toBe(b.claims.jti);
  });

  it("exports the purpose-specific TTLs from the issue", () => {
    const day = 24 * 60 * 60;
    expect(TOKEN_TTLS).toEqual({
      feedback: 14 * day,
      review_invite: 14 * day,
      consent: 30 * day,
      optout: 90 * day,
    });
  });
});

describe("tampering", () => {
  it("rejects a modified payload byte as invalid", async () => {
    const token = await mint();
    const tampered = withPayload(token, (claims) => ({
      ...claims,
      patient_id: "pat_2",
    }));
    expect(await verify(tampered)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a payload retargeted at another practice as invalid", async () => {
    const token = await mint();
    const tampered = withPayload(token, (claims) => ({
      ...claims,
      practice_id: "prac_other",
    }));
    expect(await verify(tampered)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a signature minted under a different secret as invalid", async () => {
    const forged = await createPatientToken(
      { purpose: "feedback", patientId: "pat_1", practiceId: "prac_1" },
      OTHER_SECRET,
      NOW,
    );
    expect(await verify(forged)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a swapped header alg as invalid", async () => {
    const token = await mint();
    const [, payload, signature] = token.split(".") as [string, string, string];
    const header = b64url.encode(JSON.stringify({ alg: "HS512", typ: "JWT" }));
    expect(await verify(`${header}.${payload}.${signature}`)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("rejects an alg:none construction (empty signature) as invalid", async () => {
    const token = await mint();
    const [, payload] = token.split(".") as [string, string, string];
    const header = b64url.encode(JSON.stringify({ alg: "none", typ: "JWT" }));
    expect(await verify(`${header}.${payload}.`)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("rejects structural garbage as invalid", async () => {
    for (const garbage of ["", "a.b", "a.b.c.d", "not-a-token", "..."]) {
      expect(await verify(garbage)).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("rejects non-canonical base64url (padding/alphabet tricks) as invalid", async () => {
    const token = await mint();
    const [header, payload, signature] = token.split(".") as [
      string,
      string,
      string,
    ];
    // Padded signature: decodes to the same MAC bytes, but is not canonical.
    expect(await verify(`${header}.${payload}.${signature}==`)).toEqual({
      ok: false,
      reason: "invalid",
    });
    // Standard base64 signature (padded, `+/` alphabet) decodes to the same
    // MAC bytes but is not canonical base64url — must not be accepted.
    const standardBase64Signature = btoa(b64url.decode(signature));
    expect(standardBase64Signature).not.toBe(signature);
    expect(
      await verify(`${header}.${payload}.${standardBase64Signature}`),
    ).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a payload missing claims or carrying an unknown purpose as invalid", async () => {
    const token = await mint();
    const missing = withPayload(token, ({ jti: _jti, ...rest }) => rest);
    expect(await verify(missing)).toEqual({ ok: false, reason: "invalid" });
    const unknownPurpose = withPayload(token, (claims) => ({
      ...claims,
      purpose: "admin",
    }));
    expect(await verify(unknownPurpose)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });
});

describe("expiry", () => {
  it("returns expired once now is past exp (beyond leeway)", async () => {
    const token = await mint();
    const past = new Date(NOW.getTime() + (TOKEN_TTLS.feedback + 61) * 1000);
    expect(await verify(token, { now: past })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("still verifies within the 60s clock-skew leeway", async () => {
    const token = await mint();
    const justPast = new Date(
      NOW.getTime() + (TOKEN_TTLS.feedback + 59) * 1000,
    );
    const result = await verify(token, { now: justPast });
    expect(result.ok).toBe(true);
  });
});

describe("purpose binding", () => {
  it("returns wrong_purpose for a feedback token verified as consent", async () => {
    const token = await mint("feedback");
    expect(await verify(token, { purpose: "consent" })).toEqual({
      ok: false,
      reason: "wrong_purpose",
    });
  });
});

describe("replay / single-use", () => {
  it("returns used after markUsed(jti); verify itself never consumes", async () => {
    const store = new MemoryUsedTokenStore();
    const token = await mint();

    // Patients open links repeatedly before acting: verify twice, both ok.
    const first = await verify(token, { store });
    const second = await verify(token, { store });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok) return;

    // Consumed on submission: the caller marks it used after the action commits.
    await store.markUsed(first.claims.jti, TOKEN_TTLS.feedback);
    expect(await verify(token, { store })).toEqual({
      ok: false,
      reason: "used",
    });
  });

  it("a second token for the same patient/purpose (different jti) still verifies", async () => {
    const store = new MemoryUsedTokenStore();
    const first = await verify(await mint(), { store });
    if (!first.ok) throw new Error("expected first token to verify");
    await store.markUsed(first.claims.jti, TOKEN_TTLS.feedback);

    const replacement = await verify(await mint(), { store });
    expect(replacement.ok).toBe(true);
  });

  it("MemoryUsedTokenStore forgets entries after their TTL", async () => {
    const store = new MemoryUsedTokenStore();
    await store.markUsed("jti_gone", 0);
    expect(await store.isUsed("jti_gone")).toBe(false);
  });
});

describe("check order", () => {
  it("a tampered AND used token is invalid — the store is never consulted", async () => {
    const calls: string[] = [];
    const spyStore: UsedTokenStore = {
      async isUsed(jti) {
        calls.push(jti);
        return true;
      },
      async markUsed() {},
    };
    const token = await mint();
    // Sanity: an intact token DOES reach the store (and reports used here).
    expect(await verify(token, { store: spyStore })).toEqual({
      ok: false,
      reason: "used",
    });
    expect(calls).toHaveLength(1);

    const tampered = withPayload(token, (claims) => ({
      ...claims,
      purpose: "consent",
    }));
    calls.length = 0;
    expect(await verify(tampered, { store: spyStore })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(calls).toEqual([]);
  });

  it("expired outranks used: an expired, consumed token reports expired", async () => {
    const calls: string[] = [];
    const spyStore: UsedTokenStore = {
      async isUsed(jti) {
        calls.push(jti);
        return true;
      },
      async markUsed() {},
    };
    const token = await mint();
    const past = new Date(NOW.getTime() + (TOKEN_TTLS.feedback + 120) * 1000);
    expect(await verify(token, { store: spyStore, now: past })).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(calls).toEqual([]);
  });
});

describe("secret validation (configuration errors throw)", () => {
  it("rejects a non-base64 secret", async () => {
    await expect(
      createPatientToken(
        { purpose: "feedback", patientId: "p", practiceId: "pr" },
        "not base64!!!",
      ),
    ).rejects.toThrow(/not valid base64/);
  });

  it("rejects a secret shorter than 32 bytes", async () => {
    const short = btoa("too-short");
    await expect(
      createPatientToken(
        { purpose: "feedback", patientId: "p", practiceId: "pr" },
        short,
      ),
    ).rejects.toThrow(/at least 32 bytes/);
  });
});
