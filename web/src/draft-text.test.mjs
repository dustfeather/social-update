// Node test for the draft text helpers. flattenMd decides what actually gets
// pasted into a social composer — LinkedIn and X render no Markdown, so every
// marker left behind is shown literally to a reader. That makes this the one
// function in the web app whose output IS the artifact, and it now runs on every
// draft rather than only hand-edited ones, because the generator emits Markdown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenMd, firstUrl, draftMd, normalizeDrafts } from "./draft-text.ts";

// --- emphasis --------------------------------------------------------------

test("emphasis markers are stripped, not converted to Unicode glyphs", () => {
  assert.equal(flattenMd("**shipped** the collector"), "shipped the collector");
  assert.equal(flattenMd("*shipped* the collector"), "shipped the collector");
  assert.equal(flattenMd("__shipped__ it"), "shipped it");
  assert.equal(flattenMd("***all three***"), "all three");
  assert.equal(flattenMd("~~dropped~~ kept"), "dropped kept");
  // The whole point of stripping: nothing outside ASCII reaches the post.
  assert.match(flattenMd("**bold**"), /^[\x20-\x7e]*$/);
});

test("a run of emphasis does not span from one word to the next", () => {
  assert.equal(flattenMd("*one* plain *two*"), "one plain two");
  assert.equal(flattenMd("**one** plain **two**"), "one plain two");
});

test("snake_case survives — an underscore pair is only emphasis at a word boundary", () => {
  assert.equal(flattenMd("ran collect_lock_test.mjs today"), "ran collect_lock_test.mjs today");
  assert.equal(flattenMd("the _real_ fix"), "the real fix");
});

test("an escaped marker becomes the character it was escaping", () => {
  assert.equal(flattenMd("a literal \\*star\\* here"), "a literal *star* here");
});

// --- links -----------------------------------------------------------------

test("a link is spelled out as label (url), the way a composer needs it", () => {
  assert.equal(
    flattenMd("see [the PR](https://github.com/x/y/pull/1)"),
    "see the PR (https://github.com/x/y/pull/1)"
  );
});

test("a link whose label is already the url is not doubled", () => {
  assert.equal(flattenMd("[https://x.dev](https://x.dev)"), "https://x.dev");
  assert.equal(flattenMd("<https://x.dev>"), "https://x.dev");
});

test("an image keeps its alt text and loses the rest", () => {
  assert.equal(flattenMd("![a chart](https://x.dev/c.png) shows it"), "a chart shows it");
  // The `!` must go with the image, not survive as punctuation.
  assert.doesNotMatch(flattenMd("![alt](https://x.dev/c.png)"), /!/);
});

test("a link title attribute is dropped along with the syntax", () => {
  assert.equal(flattenMd('[docs](https://x.dev "The docs")'), "docs (https://x.dev)");
});

// --- lists -----------------------------------------------------------------

test("bullets are normalised to `- item`, which reads correctly unrendered", () => {
  assert.equal(flattenMd("* one\n+ two\n- three"), "- one\n- two\n- three");
});

test("numbered items keep their number", () => {
  assert.equal(flattenMd("1. first\n2) second"), "1. first\n2. second");
});

test("nesting indentation is preserved", () => {
  assert.equal(flattenMd("- top\n  - nested"), "- top\n  - nested");
});

test("inline syntax inside a list item is still flattened", () => {
  assert.equal(flattenMd("- shipped **the thing**"), "- shipped the thing");
});

// --- block syntax ----------------------------------------------------------

test("a heading keeps its words and loses its hashes", () => {
  assert.equal(flattenMd("## This week"), "This week");
  assert.equal(flattenMd("## This week ##"), "This week");
});

test("a setext underline is dropped and its title kept", () => {
  assert.equal(flattenMd("This week\n=========\n\nbody"), "This week\n\nbody");
});

test("a blockquote loses its markers at every level", () => {
  assert.equal(flattenMd("> quoted\n>> deeper"), "quoted\ndeeper");
});

test("a horizontal rule leaves nothing behind, not a line of dashes", () => {
  assert.equal(flattenMd("before\n\n---\n\nafter"), "before\n\nafter");
  assert.equal(flattenMd("before\n\n***\n\nafter"), "before\n\nafter");
});

test("blank runs left by stripping collapse to one blank line", () => {
  assert.equal(flattenMd("a\n\n\n\n\nb"), "a\n\nb");
});

test("leading and trailing whitespace is trimmed off the post", () => {
  assert.equal(flattenMd("\n\n  shipped it  \n\n"), "shipped it");
});

// --- code ------------------------------------------------------------------

test("inline code loses its ticks and keeps its text", () => {
  assert.equal(flattenMd("run `npm test` first"), "run npm test first");
  assert.equal(flattenMd("``a `b` c``"), "a `b` c");
});

test("a fenced block's contents are passed through untouched", () => {
  // Every one of these characters is Markdown syntax outside a fence, and none
  // of it is inside one. Corrupting a code block is the worst thing this
  // function could do, because the punctuation is the meaning.
  const md = "before\n\n```sh\n# a comment\n*p = &q;\n_x_ = 1\n```\n\nafter";
  const out = flattenMd(md);
  assert.match(out, /# a comment/);
  assert.match(out, /\*p = &q;/);
  assert.match(out, /_x_ = 1/);
  assert.match(out, /^before/);
  assert.match(out, /after$/);
});

test("an unterminated fence still yields its contents rather than swallowing the rest", () => {
  assert.match(flattenMd("intro\n\n```\n*kept*"), /\*kept\*/);
});

// --- the composite case ----------------------------------------------------

test("a realistic generated draft flattens to something postable", () => {
  const md = [
    "## This week",
    "",
    "I shipped the **collector fix** — the poller could not read its own result.",
    "",
    "- root cause: `node` was not on PATH under systemd",
    "- see [the commit](https://github.com/dustfeather/social-update/commit/abc)",
    "",
    "---",
    "",
    "_Next: the editor rewrite._",
  ].join("\n");
  assert.equal(
    flattenMd(md),
    [
      "This week",
      "",
      "I shipped the collector fix — the poller could not read its own result.",
      "",
      "- root cause: node was not on PATH under systemd",
      "- see the commit (https://github.com/dustfeather/social-update/commit/abc)",
      "",
      "Next: the editor rewrite.",
    ].join("\n")
  );
  // Nothing a composer would show literally is left.
  assert.doesNotMatch(flattenMd(md), /[*_`#]|\]\(/);
});

test("plain text is already valid Markdown and passes through unchanged", () => {
  const plain = "Shipped the collector fix this week. It took three days.";
  assert.equal(flattenMd(plain), plain);
});

// --- firstUrl --------------------------------------------------------------

test("firstUrl finds a url and ignores a trailing paren", () => {
  assert.equal(
    firstUrl("see the PR (https://github.com/x/y/pull/1) today"),
    "https://github.com/x/y/pull/1"
  );
  assert.equal(firstUrl("no link here"), null);
});

test("firstUrl runs over flattened text, so a markdown link's url is found", () => {
  assert.equal(firstUrl(flattenMd("see [the PR](https://x.dev/1)")), "https://x.dev/1");
});

// --- the pre-Markdown backfill ---------------------------------------------

test("a draft written before Markdown falls back to its plain text", () => {
  assert.equal(draftMd({ text: "Shipped it." }), "Shipped it.");
  assert.equal(draftMd({ md: "**Shipped** it.", text: "Shipped it." }), "**Shipped** it.");
  assert.equal(draftMd({}), "");
});

test("an old draft's spelled-out link survives the backfill, so nothing is lost", () => {
  // htmlToText produced this shape for the one stored draft that had real
  // markup; taking `text` verbatim keeps the url a reader can follow.
  const old = { text: "see the PR (https://x.dev/1)" };
  assert.equal(flattenMd(draftMd(old)), "see the PR (https://x.dev/1)");
});

// --- normalisation ----------------------------------------------------------

test("normalizeDrafts converts a pre-Markdown draft to { angle, md }", () => {
  assert.deepEqual(normalizeDrafts([{ angle: "old", text: "plain post (https://x.dev)" }]), [
    { angle: "old", md: "plain post (https://x.dev)" },
  ]);
});

test("normalizeDrafts leaves a Markdown draft alone and drops nothing", () => {
  assert.deepEqual(normalizeDrafts([{ angle: "new", md: "**shipped** it" }]), [{ angle: "new", md: "**shipped** it" }]);
});

// The regression this exists for: a row holding one legacy draft beside a
// Markdown one. Editing EITHER card PUTs the whole array, and the server rejects
// the batch if any element lacks `md` — so the untouched legacy draft made the
// save of its neighbour fail. Every element must carry `md` after normalising.
test("a mixed row normalises every draft, not only the edited one", () => {
  const out = normalizeDrafts([
    { angle: "new", md: "# heading" },
    { angle: "legacy", text: "written before markdown" },
  ]);
  assert.equal(out.length, 2);
  for (const d of out) assert.equal(typeof d.md, "string");
  assert.equal(out[1].md, "written before markdown");
  // `text` is not carried through: it is the old copy, and keeping it beside `md`
  // would recreate the two-sources-of-truth the format change removed.
  assert.deepEqual(Object.keys(out[1]).sort(), ["angle", "md"]);
});

test("normalizeDrafts survives a draft with neither field", () => {
  assert.deepEqual(normalizeDrafts([{ angle: "empty" }]), [{ angle: "empty", md: "" }]);
  assert.deepEqual(normalizeDrafts([{}]), [{ angle: "", md: "" }]);
});
