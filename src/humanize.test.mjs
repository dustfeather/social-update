import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { mergeHumanized } = require("../dist/generate.js");

const drafts = [
  { angle: "shipped feature", text: "Original one." },
  { angle: "thing learned", text: "Original two." },
];

test("edited text replaces the original, angle is kept", () => {
  const out = mergeHumanized(drafts, JSON.stringify(["Edited one.", "Edited two."]));
  assert.deepEqual(out, [
    { angle: "shipped feature", text: "Edited one." },
    { angle: "thing learned", text: "Edited two." },
  ]);
});

test("a fenced array is unwrapped like the drafting pass", () => {
  const out = mergeHumanized(drafts, '```json\n["A.", "B."]\n```');
  assert.deepEqual(out.map((d) => d.text), ["A.", "B."]);
});

test("a different count leaves every draft untouched", () => {
  assert.deepEqual(mergeHumanized(drafts, JSON.stringify(["only one"])), drafts);
});

test("unparseable output leaves every draft untouched", () => {
  assert.deepEqual(mergeHumanized(drafts, "I have rewritten your posts!"), drafts);
});

test("a non-array leaves every draft untouched", () => {
  assert.deepEqual(mergeHumanized(drafts, JSON.stringify({ 0: "a", 1: "b" })), drafts);
});

test("an empty or non-string edit falls back per draft, not for the whole set", () => {
  const out = mergeHumanized(drafts, JSON.stringify(["Edited one.", "   "]));
  assert.deepEqual(out.map((d) => d.text), ["Edited one.", "Original two."]);
  const out2 = mergeHumanized(drafts, JSON.stringify([null, "Edited two."]));
  assert.deepEqual(out2.map((d) => d.text), ["Original one.", "Edited two."]);
});

test("surrounding whitespace is trimmed off an edit", () => {
  const out = mergeHumanized(drafts, JSON.stringify(["\n  Edited one.\n", "Edited two."]));
  assert.equal(out[0].text, "Edited one.");
});
