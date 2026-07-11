// Form parsing for actions (#141). The convention, spelled out in
// docs/frontend-conventions.md: actions never throw for validation —
// thrown errors mean bugs, returned data means user mistakes. Every action
// parses with `parseForm` and returns `{ fieldErrors }` with status 422
// via `data()` when parsing fails.
import { z } from "zod";

/** Field name → messages, the shape `Field` consumes by name. */
export type FieldErrors = Record<string, string[]>;

export type ParseFormResult<T extends z.ZodType> =
  | { ok: true; data: z.infer<T> }
  | { ok: false; fieldErrors: FieldErrors };

/**
 * Parse a request's form data against a zod schema.
 *
 * Notes:
 * - `Object.fromEntries` keeps the last value of a repeated field name;
 *   none of our forms repeat names yet. When one does (multi-checkbox),
 *   extend this helper — don't hand-roll parsing in the action.
 * - The return type is deliberately independent of zod internals
 *   (`fieldErrors` is a plain record) so a zod upgrade doesn't ripple
 *   through every action.
 */
export async function parseForm<T extends z.ZodType>(
  schema: T,
  request: Request,
): Promise<ParseFormResult<T>> {
  const formData = await request.formData();
  const result = schema.safeParse(Object.fromEntries(formData));
  if (result.success) {
    return { ok: true, data: result.data };
  }

  // z.flattenError puts each issue under its top-level field name — the
  // right granularity for flat HTML forms. Form-level issues (empty path)
  // land under "" so callers can render them above the form if one ever
  // occurs.
  const flattened = z.flattenError(result.error);
  const fieldErrors: FieldErrors = {};
  for (const [name, messages] of Object.entries(flattened.fieldErrors)) {
    if (Array.isArray(messages) && messages.length > 0) {
      fieldErrors[name] = messages as string[];
    }
  }
  if (flattened.formErrors.length > 0) {
    fieldErrors[""] = flattened.formErrors;
  }
  return { ok: false, fieldErrors };
}
