// The tagging pass runs unattended at the end of a collection, so the parts worth
// testing are the ones whose failure is silent: a chunk boundary that quietly stops
// sharing the vocabulary, and a reply that validates while covering the wrong
// sessions. Both would leave rows untagged or mistagged with nothing in the log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Against dist/, not src/ — see the note in summary.test.mjs: this package has no
// "type": "module", so Node reads src/*.ts as CommonJS and refuses their imports.
const require = createRequire(import.meta.url);
const { chunkCandidates, rankVocabulary, renderCandidates, checkTagReply } =
  require("../dist/tag-pass.js");

const candidate = (id, over = {}) => ({
  session_id: id,
  project: "social-update",
  title: `did ${id}`,
  outcome: "shipped",
  highlights: [`highlight one for ${id}`, `highlight two for ${id}`, "a third never shown"],
  ...over,
});

test("chunking covers every candidate exactly once", () => {
  const items = Array.from({ length: 7 }, (_, i) => candidate(`s${i}`));
  const chunks = chunkCandidates(items, 3);
  assert.deepEqual(chunks.map((c) => c.length), [3, 3, 1]);
  assert.deepEqual(
    chunks.flat().map((c) => c.session_id),
    items.map((c) => c.session_id)
  );
});

test("a chunk size of zero does not loop forever", () => {
  // Math.max(1, size) is the guard. Without it a CLAUDE_TAG_BATCH=0 in the env
  // hangs the end of every run with the model still resident.
  const chunks = chunkCandidates([candidate("a"), candidate("b")], 0);
  assert.deepEqual(chunks.map((c) => c.length), [1, 1]);
});

test("vocabulary is ranked by use, ties alphabetical", () => {
  const vocab = rankVocabulary({
    a: ["k3s", "warp"],
    b: ["k3s", "sqlite"],
    c: ["k3s", "warp"],
  });
  assert.deepEqual(vocab, ["k3s", "warp", "sqlite"]);
});

test("vocabulary is capped so the prompt cannot grow with the run", () => {
  const tags = Object.fromEntries(
    Array.from({ length: 50 }, (_, i) => [`s${i}`, [`tag-${String(i).padStart(2, "0")}`]])
  );
  assert.equal(rankVocabulary(tags, 10).length, 10);
});

test("only the first highlights reach the prompt", () => {
  const rendered = renderCandidates([candidate("abc")]);
  assert.match(rendered, /\[abc\] social-update — did abc \(shipped\)/);
  assert.match(rendered, /highlight two for abc/);
  assert.doesNotMatch(rendered, /a third never shown/);
});

test("a reply covering exactly the batch is accepted", () => {
  assert.deepEqual(checkTagReply({ a: ["k3s"], b: ["sqlite", "durable-writes"] }, ["a", "b"]), []);
});

test("a missing session is an error, not a silent skip", () => {
  const errs = checkTagReply({ a: ["k3s"] }, ["a", "b"]);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /"b" is missing/);
});

test("an invented session id is rejected", () => {
  const errs = checkTagReply({ a: ["k3s"], zz: ["made-up"] }, ["a"]);
  assert.ok(errs.some((e) => /"zz" was not in this batch/.test(e)));
});

test("an empty tag array is rejected", () => {
  // "[]" means "no tag fits" everywhere else in this repo. Here every session in
  // the batch has a subject, so an empty array is the model declining to answer.
  const errs = checkTagReply({ a: [] }, ["a"]);
  assert.ok(errs.some((e) => /"a" has no tags/.test(e)));
});

test("the vocabulary rules still apply", () => {
  const errs = checkTagReply({ a: ["Not Kebab"] }, ["a"]);
  assert.ok(errs.some((e) => /kebab-case/.test(e)));
});

test("a non-object reply reports only the structural error", () => {
  const errs = checkTagReply(["k3s"], ["a"]);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /must be a JSON object/);
});
