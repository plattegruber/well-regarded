import { describe, expect, it } from "vitest";
import { z } from "zod";

import { zodToToolInputSchema } from "./toolSchema.js";

describe("zodToToolInputSchema", () => {
  it("converts a flat object schema with enums and required fields", () => {
    const schema = z.object({
      sentiment: z.enum(["positive", "neutral", "negative"]),
      confidence: z.number(),
      note: z.string().optional(),
    });

    const json = zodToToolInputSchema(schema);

    expect(json.type).toBe("object");
    expect(json.additionalProperties).toBe(false);
    expect(json.required).toEqual(["sentiment", "confidence"]);
    expect(json.properties).toMatchObject({
      sentiment: {
        type: "string",
        enum: ["positive", "neutral", "negative"],
      },
      confidence: { type: "number" },
      note: { type: "string" },
    });
  });

  it("marks every nested object additionalProperties: false", () => {
    const schema = z.object({
      outer: z.object({ inner: z.object({ leaf: z.string() }) }),
      list: z.array(z.object({ item: z.number() })),
    });

    const json = zodToToolInputSchema(schema) as {
      properties: {
        outer: {
          additionalProperties: boolean;
          properties: { inner: { additionalProperties: boolean } };
        };
        list: { items: { additionalProperties: boolean } };
      };
    };

    expect(json.properties.outer.additionalProperties).toBe(false);
    expect(json.properties.outer.properties.inner.additionalProperties).toBe(
      false,
    );
    expect(json.properties.list.items.additionalProperties).toBe(false);
  });

  it("strips the $schema marker", () => {
    const json = zodToToolInputSchema(z.object({ a: z.string() }));
    expect(json.$schema).toBeUndefined();
  });

  it("rejects non-object roots — tool input_schema must be an object", () => {
    expect(() => zodToToolInputSchema(z.string())).toThrow(TypeError);
    expect(() => zodToToolInputSchema(z.array(z.string()))).toThrow(TypeError);
  });
});
