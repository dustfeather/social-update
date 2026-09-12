import fs from "fs";
import path from "path";

// The contract between a summarizing sub-agent and the importer. Kept as a
// hand-rolled validator rather than a JSON-Schema library because the errors are
// the product here: a sub-agent reads them and fixes its own file, so they have
// to say exactly which field is wrong and what was expected.

export interface SessionSummary {
  session_id: string;
  project: string;
  title: string;
  summary: string;
  highlights: string[];
  outcome: Outcome;
  occurred_at: string;
}

export const OUTCOMES = ["shipped", "partial", "exploration", "abandoned"] as const;
export type Outcome = (typeof OUTCOMES)[number];

// Sized to the platforms the drafts end up on rather than to the database: a
// title has to survive an X post, a summary a Facebook one. Highlights share the
// title's budget — they are one-liners of the same kind.
export const TITLE_MAX = 280;
export const SUMMARY_MAX = 63206;

// Printed into the orchestration prompt so the sub-agent sees the same contract
// the validator enforces — one source of truth, no drift between prose and code.
export const SCHEMA_DOC = `{
  "session_id":  string  // EXACTLY the session_id given to you; never invent one
  "project":     string  // the project name from the manifest entry
  "title":       string  // <= ${TITLE_MAX} chars, no trailing period, names what was DONE
                         // ("Sanitized draft HTML at the editor sink"), not what was asked
  "summary":     string  // 2-5 sentences, <= ${SUMMARY_MAX} chars. What changed and why it
                         // mattered. Past tense. No "the user asked" framing.
  "highlights":  string[] // 1-5 entries, each <= ${TITLE_MAX} chars. Concrete: a decision
                         // made, a bug found, a file shipped. Not a restatement of the title.
  "outcome":     one of ${JSON.stringify(OUTCOMES)}
  "occurred_at": string  // ISO-8601 UTC; use the mtime from the manifest entry
}`;

const isStr = (v: unknown): v is string => typeof v === "string";

// Returns [] when valid. Each message is addressed to whoever must fix the file.
export function validateSummary(value: unknown, expect?: { session_id?: string }): string[] {
  const errs: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["top level must be a JSON object"];
  }
  const o = value as Record<string, unknown>;

  for (const key of ["session_id", "project", "title", "summary", "occurred_at"]) {
    if (!isStr(o[key]) || !(o[key] as string).trim()) {
      errs.push(`"${key}" must be a non-empty string (got ${JSON.stringify(o[key])})`);
    }
  }
  if (expect?.session_id && o.session_id !== expect.session_id) {
    errs.push(`"session_id" must be "${expect.session_id}" (got ${JSON.stringify(o.session_id)})`);
  }
  if (isStr(o.title)) {
    if (o.title.length > TITLE_MAX) errs.push(`"title" is ${o.title.length} chars, max ${TITLE_MAX}`);
    if (/\.$/.test(o.title.trim())) errs.push(`"title" must not end with a period`);
  }
  if (isStr(o.summary) && o.summary.length > SUMMARY_MAX) {
    errs.push(`"summary" is ${o.summary.length} chars, max ${SUMMARY_MAX}`);
  }
  if (!Array.isArray(o.highlights) || o.highlights.length < 1 || o.highlights.length > 5) {
    errs.push(`"highlights" must be an array of 1-5 strings (got ${JSON.stringify(o.highlights)})`);
  } else {
    o.highlights.forEach((h, i) => {
      if (!isStr(h) || !h.trim()) errs.push(`"highlights[${i}]" must be a non-empty string`);
      else if (h.length > TITLE_MAX) errs.push(`"highlights[${i}]" is ${h.length} chars, max ${TITLE_MAX}`);
    });
  }
  if (!isStr(o.outcome) || !(OUTCOMES as readonly string[]).includes(o.outcome)) {
    errs.push(`"outcome" must be one of ${JSON.stringify(OUTCOMES)} (got ${JSON.stringify(o.outcome)})`);
  }
  if (isStr(o.occurred_at) && Number.isNaN(Date.parse(o.occurred_at))) {
    errs.push(`"occurred_at" is not a parseable date (got ${JSON.stringify(o.occurred_at)})`);
  }
  return errs;
}

// Reads and validates one file. A parse error is reported in the same shape as a
// schema error so the caller has one thing to print.
export function validateFile(file: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    return [`cannot read ${file}: ${(e as Error).message}`];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // The commonest sub-agent failure: a JSON object wrapped in a ``` fence, or
    // prose before it. Say so rather than echoing the parser's offset.
    return [
      `${path.basename(file)} is not valid JSON: ${(e as Error).message}`,
      `the file must contain the JSON object and nothing else — no code fence, no commentary`,
    ];
  }
  // The filename is the session id, so it is the authority on what the file claims.
  return validateSummary(parsed, { session_id: path.basename(file, ".json") });
}
