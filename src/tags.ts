// Tag vocabulary rules, kept in their own module so the validator is importable
// from an ESM test — see the note in summary-validate.ts.

export const TAG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_TAGS = 6;
export const TAG_MAX_LEN = 30;

export function validateTags(value: unknown): string[] {
  const errs: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ['tags.json must be a JSON object of { "<session_id>": ["tag", ...] }'];
  }
  for (const [id, list] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(list)) {
      errs.push(`"${id}" must map to an array of strings`);
      continue;
    }
    if (list.length > MAX_TAGS) errs.push(`"${id}" has ${list.length} tags, max ${MAX_TAGS}`);
    for (const t of list) {
      if (typeof t !== "string" || !TAG_RE.test(t)) {
        errs.push(`"${id}": ${JSON.stringify(t)} must be lowercase kebab-case (a-z, 0-9, "-")`);
      } else if (t.length > TAG_MAX_LEN) {
        errs.push(`"${id}": "${t}" is ${t.length} chars, max ${TAG_MAX_LEN}`);
      }
    }
  }
  return errs;
}
