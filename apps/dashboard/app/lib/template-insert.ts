// Template → composer insertion (#83 requirement 4).
//
// `renderTemplate` in @wellregarded/core does the honest substitution
// (unknown/unvalued placeholders stay literal). This helper owns the one
// composer-specific nuance: an ANONYMOUS reviewer. Most review sources
// don't give us a display name (none do today), so `{reviewer_name}`
// usually has nothing to substitute — the token is removed, the greeting
// punctuation around it is tidied ("kind words, {reviewer_name}." must not
// become "kind words, ."), and the cursor lands where the name was so the
// staff member can type one if they know it.

import { renderTemplate } from "@wellregarded/core";

const REVIEWER_TOKEN = "{reviewer_name}";

export interface InsertedTemplate {
  text: string;
  /** Caret position after insert: where the reviewer's name was removed
   * (first removal site), or the end of the text. */
  cursor: number;
}

/**
 * Render a template body for insertion into the composer.
 *
 * - `practiceName` always substitutes.
 * - With a known reviewer name, `{reviewer_name}` substitutes normally.
 * - With none, every `{reviewer_name}` is removed along with a directly
 *   preceding `", "` / `" "` (the vocative comma pattern in greeting copy),
 *   and `cursor` points at the first removal site.
 */
export function insertTemplateBody(
  body: string,
  vars: { reviewerName: string | null; practiceName: string },
): InsertedTemplate {
  const withPractice = renderTemplate(body, {
    practice_name: vars.practiceName,
    ...(vars.reviewerName ? { reviewer_name: vars.reviewerName } : {}),
  });
  if (vars.reviewerName) {
    return { text: withPractice, cursor: withPractice.length };
  }

  let text = withPractice;
  let cursor = text.length;
  let index = text.indexOf(REVIEWER_TOKEN);
  let first = true;
  while (index !== -1) {
    let removeFrom = index;
    if (text.slice(index - 2, index) === ", ") {
      removeFrom = index - 2;
    } else if (text[index - 1] === " ") {
      removeFrom = index - 1;
    }
    text =
      text.slice(0, removeFrom) + text.slice(index + REVIEWER_TOKEN.length);
    if (first) {
      cursor = removeFrom;
      first = false;
    }
    index = text.indexOf(REVIEWER_TOKEN);
  }
  if (first) cursor = text.length;
  return { text, cursor };
}
