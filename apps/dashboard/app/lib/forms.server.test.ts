import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parseForm } from "./forms.server";

const schema = z.object({
  name: z.string().min(1, "Give it a name."),
  count: z.coerce.number().int().min(1, "At least one."),
  note: z.string().optional(),
});

function postRequest(fields: Record<string, string>): Request {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    body.append(key, value);
  }
  return new Request("http://localhost/test", { method: "POST", body });
}

describe("parseForm", () => {
  it("returns typed data for a valid submission", async () => {
    const result = await parseForm(
      schema,
      postRequest({ name: "Cedar Ridge", count: "3" }),
    );
    expect(result).toEqual({
      ok: true,
      data: { name: "Cedar Ridge", count: 3 },
    });
  });

  it("coerces form-data strings per the schema", async () => {
    const result = await parseForm(
      schema,
      postRequest({ name: "x", count: "42" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.count).toBe(42);
      expect(typeof result.data.count).toBe("number");
    }
  });

  it("flattens a single failure under its field name", async () => {
    const result = await parseForm(
      schema,
      postRequest({ name: "x", count: "zero" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.fieldErrors)).toEqual(["count"]);
      expect(result.fieldErrors.count).toHaveLength(1);
    }
  });

  it("reports missing fields", async () => {
    const result = await parseForm(schema, postRequest({ name: "x" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors.count).toBeDefined();
    }
  });

  it("collects multiple errors, one entry per field", async () => {
    const result = await parseForm(
      schema,
      postRequest({ name: "", count: "-1" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors.name).toEqual(["Give it a name."]);
      expect(result.fieldErrors.count).toEqual(["At least one."]);
    }
  });

  it("handles a completely empty form", async () => {
    const result = await parseForm(schema, postRequest({}));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors.name).toBeDefined();
      expect(result.fieldErrors.count).toBeDefined();
    }
  });
});
