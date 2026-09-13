// The backfill rebuilds a tagging candidate from the columns the importer wrote,
// so this is the inverse of claude-import.ts's toItem(). Get the split wrong and
// the whole backlog is tagged from truncated titles — silently, because every
// field still looks plausible.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Against dist/ — see the note in summary.test.mjs.
const require = createRequire(import.meta.url);
const { candidateFromRow, untaggedFrom } = require("../dist/untagged.js");

const row = (over = {}) => ({
  external_id: "s1",
  title: "social-update: Unloaded the model after the run",
  body: "A summary sentence.\n\n- freed 7.9 GiB\n- only when this process loaded it",
  tags: null,
  ...over,
});

test("project and title are split back apart", () => {
  const c = candidateFromRow(row());
  assert.equal(c.project, "social-update");
  assert.equal(c.title, "Unloaded the model after the run");
  assert.deepEqual(c.highlights, ["freed 7.9 GiB", "only when this process loaded it"]);
});

test("a colon inside the title does not move the split", () => {
  // toItem() puts the project first, so the FIRST ": " is the separator and any
  // later one belongs to the sentence.
  const c = candidateFromRow(row({ title: "ollama-k3s: Fixed error: context exceeded" }));
  assert.equal(c.project, "ollama-k3s");
  assert.equal(c.title, "Fixed error: context exceeded");
});

test("a title with no project prefix keeps the whole string", () => {
  const c = candidateFromRow(row({ title: "A manual item with no project" }));
  assert.equal(c.project, "");
  assert.equal(c.title, "A manual item with no project");
});

test("a title that starts with a colon is not split into an empty project", () => {
  const c = candidateFromRow(row({ title: ": leading colon" }));
  assert.equal(c.project, "");
  assert.equal(c.title, ": leading colon");
});

test("a body with no bullets yields no highlights, not an empty string", () => {
  const c = candidateFromRow(row({ body: "Just a summary." }));
  assert.deepEqual(c.highlights, []);
});

test("outcome is absent — it does not survive the round trip", () => {
  assert.equal(candidateFromRow(row()).outcome, undefined);
});

test("a row with no external_id cannot be tagged", () => {
  // Tags are written by external_id, so a row without one has no address.
  assert.equal(candidateFromRow(row({ external_id: null })), null);
});

test("a row with nothing to tag from is dropped", () => {
  assert.equal(candidateFromRow(row({ title: "", body: "" })), null);
});

test("only NULL tags count as untagged", () => {
  const rows = [
    { ...row({ external_id: "a", tags: null }), source: "claude" },
    { ...row({ external_id: "b", tags: '["k3s"]' }), source: "claude" },
    // "[]" is a deliberate empty tag set, not an untagged row.
    { ...row({ external_id: "c", tags: "[]" }), source: "claude" },
    { ...row({ external_id: "d", tags: null }), source: "manual" },
  ];
  const got = untaggedFrom(rows, "claude", (r) => r.source);
  assert.deepEqual(got.map((c) => c.session_id), ["a"]);
});
