// Node test for the draft text helpers. flattenMd decides what actually gets
// pasted into a social composer — LinkedIn and X render no Markdown, so every
// marker left behind is shown literally to a reader. That makes this the one
// function in the web app whose output IS the artifact, and it now runs on every
// draft rather than only hand-edited ones, because the generator emits Markdown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenMd, firstUrl, draftMd, normalizeDrafts, countGraphemes, countForX, safeHref, isHostname, residualMarkers, shareState } from "./draft-text.ts";

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

test("emphasis nested inside emphasis is flattened, in both nesting orders", () => {
  // The rules run longest-run-first and once each, so the OUTER pair used to be
  // stranded: `[^*]*` forbids a marker inside the run, the `**` rule found nothing
  // across `*new*`, and by the time the `*` rule removed the inner pair the `**`
  // rule had had its turn. Only this direction failed — `*a **b** c*` always worked,
  // because there the innermost markers belong to the rule that runs first.
  assert.equal(flattenMd("**shipped the *new* collector**"), "shipped the new collector");
  assert.equal(flattenMd("*a **b** c*"), "a b c");
  assert.equal(flattenMd("__a _b_ c__"), "a b c");
  assert.equal(flattenMd("~~dropped *the* idea~~"), "dropped the idea");
});

test("nesting resolved means nothing is left for the stray warning to report", () => {
  // The warning used to fire on the outer pair and tell the author the run "does not
  // close in its paragraph" — false, and it pointed at a typo they had not made.
  assert.deepEqual(residualMarkers("**shipped the *new* collector**"), []);
});

test("running the rules to a fixed point does not loosen the flanking guards", () => {
  // A rule that matched nothing on the first pass matches nothing on the second, so
  // the loop is a no-op on text with no emphasis in it. These are the cases the
  // flanking conditions exist for, re-asserted against the looping version.
  assert.equal(flattenMd("2 * 3 and 4 * 5 and 6 * 7"), "2 * 3 and 4 * 5 and 6 * 7");
  assert.equal(flattenMd("snake_case_name and another_one_here"), "snake_case_name and another_one_here");
  assert.equal(flattenMd("a * b ** c"), "a * b ** c");
});

test("snake_case survives — an underscore pair is only emphasis at a word boundary", () => {
  assert.equal(flattenMd("ran collect_lock_test.mjs today"), "ran collect_lock_test.mjs today");
  assert.equal(flattenMd("the _real_ fix"), "the real fix");
});

test("asterisks used as arithmetic are not emphasis — flanking is required", () => {
  // This silently DELETED both operators: the first `*` opened, the class ate
  // " 3 and 4 ", the second closed. prompt.txt promises every number reaches the
  // post exactly as given, so losing characters is the one failure mode that
  // matters most here.
  assert.equal(flattenMd("2 * 3 and 4 * 5"), "2 * 3 and 4 * 5");
  assert.equal(flattenMd("a ** b ** c"), "a ** b ** c");
  assert.equal(flattenMd("a ~~ b ~~ c"), "a ~~ b ~~ c");
  // And the real emphasis it must still strip, so the guard did not turn it off.
  assert.equal(flattenMd("shipped *the thing* today"), "shipped the thing today");
  assert.equal(flattenMd("shipped **the thing** today"), "shipped the thing today");
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

// The span's CONTENTS are the point: the ticks came off correctly before, but the
// link/image/emphasis rules had already run over what was inside them.
test("a code span's contents survive the inline rules verbatim", () => {
  assert.equal(flattenMd("`[a](b)`"), "[a](b)");
  assert.equal(flattenMd("`**x**`"), "**x**");
  assert.equal(flattenMd("`a *b* c`"), "a *b* c");
  assert.equal(flattenMd("`![i](u)`"), "![i](u)");
  // The realistic case: a path with underscores, which the emphasis rule would eat.
  assert.equal(flattenMd("run `social_collect_poll.sh --once`"), "run social_collect_poll.sh --once");
});

test("an escaped backtick does not open a code span", () => {
  assert.equal(flattenMd("\\`not code\\` **bold**"), "`not code` bold");
});

test("inline code loses its ticks and keeps its text", () => {
  assert.equal(flattenMd("run `npm test` first"), "run npm test first");
  assert.equal(flattenMd("``a `b` c``"), "a `b` c");
});

test("a code span that crosses a line break is not rewritten by the LINE rules", () => {
  // flattenLine runs per line and used to run BEFORE the spans were parked, so the
  // second line of a span was read as Markdown structure and rewritten — and the
  // restore then put the rewrite back verbatim. Same argument as splitFences, one
  // level down: punctuation inside code is load-bearing.
  assert.equal(flattenMd("say `x\n* y` done"), "say x\n* y done");
  assert.equal(flattenMd("a `b\n> c` d"), "a b\n> c d");
  assert.equal(flattenMd("a `b\n# c` d"), "a b\n# c d");
  assert.equal(flattenMd("a `b\n1. c` d"), "a b\n1. c d");
});

test("a sentinel character in the draft itself is left alone, not turned into \"undefined\"", () => {
  // The parking sentinels are NUL and SOH — "characters that cannot occur in the
  // source" right up until someone pastes one, and the draft round-trips through the
  // database. An index nothing parked resolved to undefined, which String.replace
  // stringifies into the post.
  const NUL = String.fromCharCode(0);
  const SOH = String.fromCharCode(1);
  assert.equal(flattenMd(`paste ${NUL}7${NUL} here`), `paste ${NUL}7${NUL} here`);
  assert.equal(flattenMd(`paste ${SOH}7${SOH} here`), `paste ${SOH}7${SOH} here`);
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

test("a fence keeps its blank runs and trailing spaces, which the prose rules strip", () => {
  // The two cleanups that run over prose — collapsing blank runs and trimming
  // trailing whitespace — are exactly what a code block must not receive. The
  // fixture above has neither, so it could not have caught this: the block is
  // whitespace-sensitive on purpose.
  const md = "before\n\n```py\ndef a():\n    pass   \n\n\ndef b():\n    pass\n```\n\nafter";
  assert.equal(flattenMd(md), "before\n\ndef a():\n    pass   \n\n\ndef b():\n    pass\n\nafter");
});

test("a draft that is only a code block keeps its own indentation", () => {
  // The outer trim is what would eat this, so it applies only where the edge is
  // prose. An author pasting an indented snippet gets the snippet back.
  assert.equal(flattenMd("```\n    indented\n```"), "    indented");
});

test("prose around a fence is still collapsed and trimmed", () => {
  assert.equal(flattenMd("\n\n# title\n\n\n\nbefore   \n\n```\nx\n```\n\n\n"), "title\n\nbefore\n\nx");
});

test("a closing fence may be longer than the opening one", () => {
  // CommonMark allows it, and an author quoting a block that itself contains ```
  // has to use it. Requiring an exact match read this as unterminated and ate the
  // rest of the draft as code.
  assert.equal(flattenMd("before\n\n````\n```\n````\n\nafter"), "before\n\n```\n\nafter");
  // A tilde tail cannot close a backtick fence.
  assert.match(flattenMd("a\n\n```\nx\n~~~\n"), /~~~/);
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

test("firstUrl takes the source and flattens it, so a markdown link's url is found", () => {
  assert.equal(firstUrl("see [the PR](https://x.dev/1)"), "https://x.dev/1");
});

test("a url that only exists inside a fence is not a link to share", () => {
  const md = "Ran the migration.\n\n```sh\ncurl https://api.internal/x\n```\n";
  assert.equal(firstUrl(md), null);
  // …and it is still in the post itself, verbatim — only the SHARE target is None.
  assert.match(flattenMd(md), /curl https:\/\/api\.internal\/x/);
});

test("a url inside a code span is not a link to share either", () => {
  assert.equal(firstUrl("hit `https://api.internal/x` to check"), null);
});

test("prose wins over a fence that came first", () => {
  assert.equal(
    firstUrl("```\nhttps://api.internal/x\n```\n\nWrote it up: https://blog.dev/p/1"),
    "https://blog.dev/p/1"
  );
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

// --- counting ---------------------------------------------------------------
// These numbers decide whether a share button is DISABLED, so counting the wrong
// unit refuses posts the network would have accepted.

test("an emoji counts as one character, not its UTF-16 length", () => {
  const e = "\u{1F680}"; // rocket: 2 code units, 1 grapheme
  assert.equal(e.length, 2);
  assert.equal(countGraphemes(e), 1);
});

test("a ZWJ emoji sequence counts as the one glyph a reader sees", () => {
  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
  assert.ok(family.length > 4);
  assert.equal(countGraphemes(family), 1);
});

test("X bills any URL at 23 characters, however long it is", () => {
  const long = "https://github.com/dustfeather/social-update/commit/36ad3d4aaaaaaaaaaaaaaaaaaaaaaaaa";
  assert.ok(long.length > 23);
  assert.equal(countForX(`see ${long}`), "see ".length + 23);
  // The case that was being wrongly blocked: under 280 for X, over it by raw length.
  const draft = `${"x".repeat(250)} ${long}`; // 250 + space + 23 = 274 for X
  assert.ok(draft.length > 280);
  assert.ok(countForX(draft) <= 280);
});

test("a draft with no URL counts the same for X as for anyone else", () => {
  const plain = "shipped the collector fix";
  assert.equal(countForX(plain), countGraphemes(plain));
});

// --- safeHref ---------------------------------------------------------------
// Restored: these went out with the HTML sanitizer's tests, but this function's SINK
// did not. `item.url` is collector output from the DB and becomes a real <a href> in
// the item list (App.tsx:49), so this is the one remaining injection boundary in the
// web app — and the draft-format change did nothing to remove it.

test("a javascript: url is refused rather than made clickable", () => {
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("JavaScript:alert(1)"), null); // scheme match is case-insensitive
  assert.equal(safeHref("  javascript:alert(1)  "), null); // and survives padding
});

test("a data: url is refused too", () => {
  assert.equal(safeHref("data:text/html;base64,PHNjcmlwdD4="), null);
});

test("an unknown scheme is refused rather than guessed at", () => {
  assert.equal(safeHref("file:///etc/passwd"), null);
  assert.equal(safeHref("vbscript:msgbox"), null);
});

test("http, https and mailto pass through unchanged", () => {
  assert.equal(safeHref("https://github.com/x"), "https://github.com/x");
  assert.equal(safeHref("http://example.com"), "http://example.com");
  assert.equal(safeHref("mailto:someone@example.com"), "mailto:someone@example.com");
});

test("a relative url stays relative and a bare domain gets https", () => {
  assert.equal(safeHref("/items/3"), "/items/3");
  assert.equal(safeHref("#section"), "#section");
  assert.equal(safeHref("example.com/x"), "https://example.com/x");
});

// --- isHostname -------------------------------------------------------------
// This value is interpolated into `https://<host>/share`, so a bad shape becomes a
// broken URL the user is dropped on with their draft gone.

// --- residual markers -------------------------------------------------------

test("an unbalanced marker survives flattening rather than being guessed at", () => {
  // Pinning the behaviour rather than the absence of one: a half-written bold run
  // reaches the composer as literal asterisks, and the UI warns instead of
  // repairing it.
  assert.equal(flattenMd("**shipped the collector"), "**shipped the collector");
  assert.deepEqual(residualMarkers("**shipped the collector"), ["**"]);
});

test("a balanced draft has no residual markers", () => {
  assert.deepEqual(residualMarkers("**shipped** the _collector_"), []);
});

test("residual markers are reported once each, not per occurrence", () => {
  assert.deepEqual(residualMarkers("**a **b ~~c"), ["**", "~~"]);
});

test("a single asterisk or underscore is not reported — it is ordinary text", () => {
  // `2 * 3` and a lone footnote marker are not broken emphasis, and a warning
  // that fires on them would train the author to ignore it.
  assert.deepEqual(residualMarkers("2 * 3 = 6, see note *"), []);
});

test("emphasis spans a soft line break, the way the editor renders it", () => {
  // The inline pass used to run per LINE, so a run across a newline could never
  // match however the character classes were written — and CodeMirror highlighted
  // it as bold, so the author saw bold and the post shipped asterisks.
  assert.equal(flattenMd("**bold across\nlines**"), "bold across\nlines");
  assert.equal(flattenMd("*italic across\nlines*"), "italic across\nlines");
  assert.deepEqual(residualMarkers("**bold across\nlines**"), []);
});

test("emphasis does NOT span a blank line — that is two paragraphs", () => {
  // CommonMark stops a run at a paragraph break, so these are four literal
  // asterisks and the author needs to hear about them.
  assert.equal(flattenMd("**para\n\nbreak**"), "**para\n\nbreak**");
  assert.deepEqual(residualMarkers("**para\n\nbreak**"), ["**"]);
});

test("a single unclosed marker is reported too, not just a doubled one", () => {
  // Only **, __ and ~~ were checked, so a whole unclosed italic run reached the
  // composer with nothing on screen saying so.
  assert.deepEqual(residualMarkers("*italic across lines still open"), ["*"]);
  assert.deepEqual(residualMarkers("_underline that never closes"), ["_"]);
});

test("only an OPENER position counts, which is what keeps the warning quiet", () => {
  assert.deepEqual(residualMarkers("2 * 3 = 6, see note *"), []);   // space after, then nothing after
  assert.deepEqual(residualMarkers("ran collect_lock_test.mjs"), []); // mid-word
  assert.deepEqual(residualMarkers("a ** b ** c"), []);              // not emphasis, not flagged
});

test("markers inside code are not strays — the author cannot fix what is correct", () => {
  // residualMarkers reads the SOURCE, because in flattened text a code span has
  // already been restored verbatim and its markers look identical to unclosed ones.
  assert.deepEqual(residualMarkers("call it with `**kwargs` and see"), []);
  assert.deepEqual(residualMarkers("before\n\n```py\ndef f(**kw): pass\n```\n\nafter"), []);
  // A real stray elsewhere in the same draft is still caught.
  assert.deepEqual(residualMarkers("**oops and `**kwargs` here"), ["**"]);
});

test("an escaped marker is not a stray — it is a character the author asked for", () => {
  assert.deepEqual(residualMarkers("a literal \\*star\\* and \\_under\\_"), []);
});

// --- the share decision ------------------------------------------------------

const X = { limit: 280, count: countForX };
const LINKEDIN = { limit: 3000 };
const MASTODON = { limit: 500, soft: true };
const BLUESKY = { limit: 300 };
const HN = { limit: 80, urlOnly: true };

test("a draft inside every limit disables nothing", () => {
  const s = shareState(LINKEDIN, "shipped the collector fix", null);
  assert.deepEqual([s.tooLong, s.noUrl, s.disabled, s.warn], [false, false, false, false]);
});

test("a hard limit disables the button; a soft one only warns", () => {
  const long = "x".repeat(600);
  assert.equal(shareState(BLUESKY, long, null).disabled, true);
  const m = shareState(MASTODON, long, null);
  // The instance may well accept it — refusing a post it would have taken is the
  // worse error, so the button stays live and says why.
  assert.deepEqual([m.tooLong, m.disabled, m.warn], [true, false, true]);
});

test("a url-only target is disabled with no url, whatever the length", () => {
  assert.equal(shareState(HN, "short", null).disabled, true);
  assert.equal(shareState(HN, "short", "https://x.dev").disabled, false);
});

test("a url-only target with a url can still be too long", () => {
  const s = shareState(HN, "x".repeat(200), "https://x.dev");
  assert.deepEqual([s.tooLong, s.noUrl, s.disabled], [true, false, true]);
});

test("the per-network count decides, not the generic one", () => {
  // 260 chars plus a 40-char URL is 301 graphemes but 284 for X, which bills every
  // URL at 23 — so X refuses a draft the raw count says fits.
  const text = "x".repeat(260) + " https://example.com/a/rather/long/path";
  assert.equal(shareState(X, text, "https://example.com/a/rather/long/path").tooLong, true);
  assert.equal(shareState(LINKEDIN, text, null).tooLong, false);
});

test("an emoji costs one character in the decision, not its UTF-16 length", () => {
  assert.equal(shareState({ limit: 2 }, "👩‍💻!", null).tooLong, false);
});

test("a plain instance hostname is accepted", () => {
  assert.equal(isHostname("mastodon.social"), true);
  assert.equal(isHostname("hachyderm.io"), true);
  assert.equal(isHostname("social.example.co.uk"), true);
  assert.equal(isHostname("my-instance.example.org"), true);
});

test("anything that is not a bare hostname is refused", () => {
  assert.equal(isHostname(""), false);
  assert.equal(isHostname("mastodon"), false); // no dot — not a reachable host
  assert.equal(isHostname("mastodon social"), false);
  assert.equal(isHostname("masto/don.social"), false);
  assert.equal(isHostname("-leading.example"), false);
  assert.equal(isHostname("trailing-.example"), false);
  assert.equal(isHostname("double..dot"), false);
});

// The honest limit of this check, stated so nobody assumes more of it.
test("a well-formed but wrong hostname still passes — only the UI can fix a typo", () => {
  assert.equal(isHostname("mastodon.socail"), true);
});
