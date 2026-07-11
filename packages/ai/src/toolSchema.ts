/**
 * zod → tool `input_schema` conversion (issue #63).
 *
 * Structured output is forced via tool use: `AnthropicProvider` defines a
 * single tool whose `input_schema` is generated from the caller's zod
 * schema and sets `tool_choice: {type: "tool", ...}` so the model must
 * emit conforming JSON. This module owns that conversion.
 *
 * Note on the issue's `zod-to-json-schema` pointer: that library targets
 * zod v3. This repo is on zod v4, which ships the conversion natively as
 * `z.toJSONSchema()` — same output, one fewer dependency. We keep the
 * output strict (`additionalProperties: false` on every object node) per
 * the issue's implementation notes; prefer flat schemas — deeply nested
 * optionals degrade conformance from Haiku-class models.
 */

import { z } from "zod";

/** JSON-schema node (loosely typed — we only walk objects and arrays). */
type JsonSchemaNode = { [key: string]: unknown };

function enforceStrictObjects(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) enforceStrictObjects(item);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const record = node as JsonSchemaNode;
  if (record.type === "object" && record.additionalProperties === undefined) {
    record.additionalProperties = false;
  }
  for (const value of Object.values(record)) enforceStrictObjects(value);
}

/**
 * Convert a zod schema into a strict JSON schema suitable for a tool's
 * `input_schema`. Every object node carries `additionalProperties: false`
 * (zod v4 emits this for plain `z.object`s already; we enforce it
 * defensively for anything it leaves open), and the `$schema` marker is
 * stripped — the Messages API neither wants nor needs it.
 */
export function zodToToolInputSchema(schema: z.ZodType): JsonSchemaNode {
  const jsonSchema = z.toJSONSchema(schema) as JsonSchemaNode;
  delete jsonSchema.$schema;
  enforceStrictObjects(jsonSchema);
  if (jsonSchema.type !== "object") {
    throw new TypeError(
      "classify schemas must be z.object(...) at the top level — tool input_schema requires an object root",
    );
  }
  return jsonSchema;
}
