// The validator is the contract a sub-agent self-corrects against, so its error
// messages are load-bearing: a vague one costs a retry loop, a missing one costs
// a silently dropped session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// These tests run against dist/, not src/. The server half of this repo has no
// "type": "module", so Node reads src/*.ts as CommonJS and refuses the ESM
// `import` statements inside them — neither import nor require of the source
// works from here. The compiled output is plain CommonJS and is also what
// actually ships, so `npm run build` has to come first (the pre-commit hook and
// `build:all` already order it that way).
const require = createRequire(import.meta.url);
const { validateSummary } = require("../dist/summary.js");

// The caps and the outcome list are spelled out rather than imported. This
// package has no "type": "module", so src/*.ts is CommonJS; an .mjs test reading
// its exports goes through Node's cjs lexer, which reliably exposes function
// declarations but not every `export const`. Pinning the literals here is also
// the stricter test: a change to a cap has to be made deliberately in both places.
const TITLE_MAX = 280;
const SUMMARY_MAX = 63206;
const OUTCOMES = ["shipped", "partial", "exploration", "abandoned"];
const { validateTags } = require("../dist/tags.js");

const good = () => ({
  session_id: "abc-123",
  project: "social-update",
  title: "Replaced the session collector with a summarizing agent run",
  summary: "Swapped first-prompt extraction for per-session summaries. Each transcript is read in full by its own sub-agent.",
  highlights: ["One sub-agent per changed session", "Tags assigned in a single cross-session pass"],
  outcome: "shipped",
  occurred_at: "2026-09-12T10:00:00.000Z",
});

test("a well-formed summary validates", () => {
  assert.deepEqual(validateSummary(good()), []);
});

test("the session id must match the one the sub-agent was given", () => {
  const errs = validateSummary(good(), { session_id: "other-id" });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /"session_id" must be "other-id"/);
});

test("missing and empty fields are named individually", () => {
  const s = { ...good(), title: "", project: undefined };
  const errs = validateSummary(s);
  assert.ok(errs.some((e) => e.startsWith('"title"')));
  assert.ok(errs.some((e) => e.startsWith('"project"')));
});

test("a title is capped and must not end in a period", () => {
  assert.match(validateSummary({ ...good(), title: "x".repeat(TITLE_MAX + 1) })[0], /max 280/);
  assert.match(validateSummary({ ...good(), title: "Shipped the thing." })[0], /must not end with a period/);
});

test("summary length is bounded by the longest post a draft could become", () => {
  assert.deepEqual(validateSummary({ ...good(), summary: "x".repeat(SUMMARY_MAX) }), []);
  assert.match(validateSummary({ ...good(), summary: "x".repeat(SUMMARY_MAX + 1) })[0], /max 63206/);
});

test("highlights must be 1-5 non-empty strings", () => {
  assert.match(validateSummary({ ...good(), highlights: [] })[0], /1-5 strings/);
  assert.match(validateSummary({ ...good(), highlights: new Array(6).fill("x") })[0], /1-5 strings/);
  assert.match(validateSummary({ ...good(), highlights: [""] })[0], /highlights\[0\]/);
});

test("outcome is closed to the four known values", () => {
  for (const o of OUTCOMES) assert.deepEqual(validateSummary({ ...good(), outcome: o }), []);
  assert.match(validateSummary({ ...good(), outcome: "done" })[0], /"outcome" must be one of/);
});

test("an unparseable date is caught rather than stored as NULL week", () => {
  assert.match(validateSummary({ ...good(), occurred_at: "last tuesday" })[0], /not a parseable date/);
});

test("a top-level array or string is rejected outright", () => {
  assert.deepEqual(validateSummary([good()]), ["top level must be a JSON object"]);
  assert.deepEqual(validateSummary("{}"), ["top level must be a JSON object"]);
});

test("tags must be lowercase kebab-case, at most six per session", () => {
  assert.deepEqual(validateTags({ "abc-123": ["ci", "bug-fix"] }), []);
  assert.match(validateTags({ "abc-123": ["Bug Fix"] })[0], /kebab-case/);
  assert.match(validateTags({ "abc-123": new Array(7).fill("ci") })[0], /max 6/);
  assert.match(validateTags({ "abc-123": "ci" })[0], /must map to an array/);
  assert.match(validateTags([])[0], /must be a JSON object/);
});
