import { z } from "zod";

/**
 * Practice profile form schema — the boundary contract for the dashboard's
 * Settings → Practice profile page (#141) and, later, any API surface that
 * edits the same columns on `practices` in `@wellregarded/db`.
 *
 * Boundary schemas live here in core, not in the app: the dashboard action
 * parses with this schema, and when the Hono API grows a matching endpoint
 * it must reuse it rather than re-deriving the rules.
 *
 * Form data arrives as strings (possibly empty); the schema normalizes:
 * - `name` is required and trimmed.
 * - `phone` and `websiteUrl` are optional — an empty input clears the value
 *   (the columns are nullable), so `""` becomes `null`.
 * - `timezone` must be a real IANA zone; validated by constructing an
 *   `Intl.DateTimeFormat`, which works identically in Node and workerd
 *   without shipping a zone list.
 */

/** True when `Intl` accepts the string as an IANA time zone. */
export function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** An optional trimmed string field where an empty submission means null. */
const optionalTrimmed = z
  .string()
  .trim()
  .transform((value) => (value === "" ? null : value));

export const practiceProfileSchema = z.object({
  name: z.string().trim().min(1, "Give the practice a name."),
  phone: optionalTrimmed.pipe(
    z.string().max(32, "That looks too long for a phone number.").nullable(),
  ),
  websiteUrl: optionalTrimmed.pipe(
    z.url({ error: "Enter a full URL, like https://example.com." }).nullable(),
  ),
  timezone: z
    .string()
    .refine(isIanaTimeZone, "Choose a time zone from the list."),
});

export type PracticeProfileInput = z.infer<typeof practiceProfileSchema>;
