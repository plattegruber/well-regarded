import { createLogger } from "@wellregarded/core";
import { describe, expect, it } from "vitest";

import { loader } from "./healthz";

function loaderArgs(env: Partial<Env>) {
  const request = new Request("http://localhost/healthz");
  return {
    request,
    url: new URL(request.url),
    pattern: "/healthz",
    params: {},
    context: {
      cloudflare: {
        env: env as Env,
        ctx: {} as ExecutionContext,
      },
      requestId: "test-request-id",
      logger: createLogger({
        worker: "dashboard",
        requestId: "test-request-id",
        sink: () => {},
      }),
    },
  };
}

describe("/healthz", () => {
  it("reports ok with the deployed sha", async () => {
    const response = loader(loaderArgs({ GIT_SHA: "abc1234" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      sha: "abc1234",
    });
  });

  it("falls back to 'dev' when GIT_SHA is not set (local dev)", async () => {
    const response = loader(loaderArgs({}));
    await expect(response.json()).resolves.toEqual({ ok: true, sha: "dev" });
  });
});
