// Action-recipe unit tests for the reference CRUD page (#141). These run
// in the default node environment on purpose: loaders and actions are
// server code, and the DOM shims (see settings.practice.test.tsx) replace
// FormData/Headers with implementations the server runtime never sees.
import { createLogger } from "@wellregarded/core";
import { beforeEach, describe, expect, it } from "vitest";

import {
  DEMO_PRACTICE_ID,
  practiceStore,
  resetPracticeStore,
} from "~/lib/practice-store.server";
import { action, loader } from "./settings.practice";

beforeEach(resetPracticeStore);

const VALID = {
  name: "Cedar Ridge Dental",
  phone: "(555) 201-4400",
  websiteUrl: "https://cedarridgedental.example",
  timezone: "America/Chicago",
};

function actionArgs(fields: Record<string, string>) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    body.append(key, value);
  }
  const request = new Request("http://localhost/settings/practice", {
    method: "POST",
    body,
  });
  return {
    request,
    url: new URL(request.url),
    pattern: "/settings/practice",
    params: {},
    context: {
      cloudflare: {
        env: { ENVIRONMENT: "local" } as Env,
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

describe("practice profile loader", () => {
  it("returns the practice row and the timezone list", async () => {
    const data = await loader();
    expect(data.practice).toMatchObject(VALID);
    expect(data.timezones).toContain("America/Chicago");
  });
});

describe("practice profile action", () => {
  it("saves a valid submission, flashes, and redirects", async () => {
    const result = await action(
      actionArgs({ ...VALID, name: "Cedar Ridge Dental & Ortho" }),
    );
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/settings/practice");
    expect(response.headers.get("Set-Cookie")).toContain("__wr_flash");

    const saved = await practiceStore.get(DEMO_PRACTICE_ID);
    expect(saved?.name).toBe("Cedar Ridge Dental & Ortho");
  });

  it("returns 422 field errors for an invalid URL — never throws", async () => {
    const result = await action(actionArgs({ ...VALID, websiteUrl: "nope" }));
    expect(result).not.toBeInstanceOf(Response);
    expect(result).toMatchObject({
      init: { status: 422 },
      data: {
        fieldErrors: {
          websiteUrl: ["Enter a full URL, like https://example.com."],
        },
      },
    });
    // The store was not touched.
    const saved = await practiceStore.get(DEMO_PRACTICE_ID);
    expect(saved?.websiteUrl).toBe(VALID.websiteUrl);
  });

  it("collects multiple field errors in one response", async () => {
    const result = await action(
      actionArgs({
        name: "",
        phone: "x",
        websiteUrl: "nope",
        timezone: "Mars/Base",
      }),
    );
    expect(result).toMatchObject({ init: { status: 422 } });
    const { fieldErrors } = (
      result as { data: { fieldErrors: Record<string, string[]> } }
    ).data;
    expect(Object.keys(fieldErrors).sort()).toEqual([
      "name",
      "timezone",
      "websiteUrl",
    ]);
  });

  it("clears optional fields submitted empty", async () => {
    const result = await action(
      actionArgs({ ...VALID, phone: "", websiteUrl: "" }),
    );
    expect(result).toBeInstanceOf(Response);
    const saved = await practiceStore.get(DEMO_PRACTICE_ID);
    expect(saved?.phone).toBeNull();
    expect(saved?.websiteUrl).toBeNull();
  });
});
