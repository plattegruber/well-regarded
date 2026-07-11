import { describe, expect, it } from "vitest";

import { type FlashEnv, readFlash, setFlash } from "./flash.server";

const env: FlashEnv = { ENVIRONMENT: "local" };

/** Turn a Set-Cookie header into the Cookie header a browser would send. */
function cookieFrom(headers: Headers): string {
  const setCookie = headers.get("Set-Cookie");
  if (!setCookie) {
    throw new Error("no Set-Cookie header");
  }
  return setCookie.split(";")[0] as string;
}

function requestWithCookie(cookie: string): Request {
  return new Request("http://localhost/", { headers: { Cookie: cookie } });
}

describe("flash round trip", () => {
  it("set → read returns the message, then clears", async () => {
    const setHeaders = await setFlash(env, {
      tone: "positive",
      message: "Practice profile saved",
      detail: "Visible after the redirect.",
    });

    const first = await readFlash(
      env,
      requestWithCookie(cookieFrom(setHeaders)),
    );
    expect(first.flash).toMatchObject({
      tone: "positive",
      message: "Practice profile saved",
      detail: "Visible after the redirect.",
    });
    expect(first.flash?.id).toBeTruthy();
    // Reading consumed the flash: the returned headers carry the cleared
    // cookie, and presenting that cookie yields nothing.
    expect(first.headers).toBeDefined();
    const second = await readFlash(
      env,
      requestWithCookie(cookieFrom(first.headers as Headers)),
    );
    expect(second.flash).toBeNull();
    expect(second.headers).toBeUndefined();
  });

  it("returns null (and no headers) when there is no cookie", async () => {
    const result = await readFlash(env, new Request("http://localhost/"));
    expect(result.flash).toBeNull();
    expect(result.headers).toBeUndefined();
  });

  it("gives each flash a distinct id", async () => {
    const a = await readFlash(
      env,
      requestWithCookie(
        cookieFrom(await setFlash(env, { tone: "neutral", message: "one" })),
      ),
    );
    const b = await readFlash(
      env,
      requestWithCookie(
        cookieFrom(await setFlash(env, { tone: "neutral", message: "two" })),
      ),
    );
    expect(a.flash?.id).not.toBe(b.flash?.id);
  });

  it("refuses to run without a secret outside local", async () => {
    await expect(
      setFlash({ ENVIRONMENT: "prod" }, { tone: "neutral", message: "x" }),
    ).rejects.toThrow("SESSION_SECRET");
  });
});
