// Pure text helpers for the draft editor. Kept out of App.tsx so they can be
// exercised directly (see draft-text.test.mjs) — flattenMd decides what actually
// gets pasted into a social composer, so it is the part worth pinning down.
//
// A draft is `{ angle, md }`. Markdown is the stored source and the only thing
// the generator, the editor and the API ever persist. The plain text a composer
// receives is DERIVED here and never stored, so it cannot go stale against the
// Markdown it came from — there is no second copy to disagree.
//
// This file used to hold an HTML sanitizer, because the editor was a
// contenteditable seeded with innerHTML and every path into it was an injection
// sink. A Markdown source editor has no such sink: the value is text, it is
// rendered into the editor and a <pre>, and nothing is ever parsed as HTML. The
// sanitizer was not hardened, it was deleted along with the sink it guarded.
//
// `safeHref` stayed, and the distinction matters: it never guarded draft markup.
// It guards the `url` an ITEM carries, which is collector output stored in the DB
// and rendered as a real <a href> in the item list. That sink is untouched by the
// draft format, so removing this with the rest would have made a `javascript:`
// item url clickable again.

// --- Flattening ------------------------------------------------------------
// LinkedIn and X take PLAIN TEXT. They render no Markdown at all, so any syntax
// left in the output is shown literally — `**shipped**` reaches a reader as four
// asterisks around a word. Flattening is therefore not a nicety, it is the step
// that makes a draft postable, and it runs on every draft rather than only on
// hand-edited ones now that the generator emits Markdown too.
//
// What survives is what reads correctly as plain text on its own: list bullets,
// numbered items, and a link spelled out as `label (url)`. What is stripped is
// what only means something to a renderer: emphasis runs, heading hashes, code
// ticks, blockquote markers, rules.
//
// Emphasis markers are STRIPPED rather than converted to the Unicode bold
// glyphs LinkedIn posts often use. Those glyphs do render bold there, but screen
// readers announce them character by character or skip them entirely, and they
// do not match LinkedIn's own search. The emphasis stays in the stored Markdown
// as authoring intent; it just does not reach the post.

// Fenced code blocks are pulled out FIRST and their contents passed through
// untouched. Inside a fence, `# x` is a shell comment and `*p` is a pointer —
// applying the line rules to them would corrupt the one kind of content whose
// punctuation is load-bearing.
function splitFences(md: string): Array<{ code: boolean; text: string }> {
  const out: Array<{ code: boolean; text: string }> = [];
  // `(?![\s\S])` rather than `$` for the unterminated case. The `m` flag is
  // needed for `^` on the closing fence, and under it `$` matches at every line
  // END — so the lazy body stopped at the first newline, the block's remaining
  // lines were flattened as prose, and the closing fence matched again as a
  // second, empty block.
  //
  // The closing run may be LONGER than the opening one, which CommonMark allows and
  // authors use to quote a block that itself contains three backticks. Matching the
  // opening run exactly meant a block opened with ``` and closed with ```` was read
  // as never closed, so the whole rest of the draft was swallowed as code. `\2` is
  // the fence CHARACTER, captured separately so the tail cannot mix ` with ~.
  const re = /^[ \t]*((`|~)\2{2,})[^\n]*\n([\s\S]*?)(?:^[ \t]*\1\2*[ \t]*$|(?![\s\S]))/gm;
  let last = 0;
  for (const m of md.matchAll(re)) {
    const start = m.index ?? 0;
    if (start > last) out.push({ code: false, text: md.slice(last, start) });
    out.push({ code: true, text: m[3] });
    last = start + m[0].length;
  }
  if (last < md.length) out.push({ code: false, text: md.slice(last) });
  return out;
}

// Inline constructs, in an order chosen so one does not eat another's markers.
//
// A backslash escape is taken out of the text FIRST, not unescaped last. `\*` is
// a literal asterisk the author escaped precisely so it would not be read as
// syntax — but every rule below sees a bare `*`, so `\*star\*` was matched as
// emphasis around `star\` and came out as `\star\`. Parking each escape on a
// character that cannot occur in the source (NUL) makes it invisible to the
// rules, and it is restored once they have all run.
const ESC_OPEN = "\u0000";
const CODE_OPEN = "\u0001";

const CODE_SENTINEL = /\u0001(\d+)\u0001/g;

// Code spans come out of the text before ANY rule rewrites it — the line rules
// included, which is why this is called by flattenMd rather than by flattenInline.
// A span may cross a line break, and flattenLine runs per line: `` `x\n* y` `` had
// its second line read as a list item and rewritten to `- y`, and the restore then
// put that rewrite back verbatim. The blockquote, heading, ordered-list and
// horizontal-rule rules all had the same reach. splitFences exists because
// punctuation inside code is load-bearing, and the file said so — "that argument
// does not stop at the fence" — while the ordering here stopped exactly there.
//
// The backreference still closes a run of N ticks with a run of N, so ``a `b` c``
// remains one span whose text contains ticks. The lookbehinds keep an escaped tick
// (\`) from opening or closing a span, which is why this runs before the escape
// pass rather than after: once \` is parked on a sentinel the delimiter is
// invisible here.
function parkSpans(text: string, spans: string[]): string {
  return text.replace(/(?<!\\)(`+)([\s\S]+?)(?<!\\)\1/g, (_m, _ticks: string, body: string) => {
    spans.push(body);
    return `${CODE_OPEN}${spans.length - 1}${CODE_OPEN}`;
  });
}

// The span's text returns exactly as written, minus its ticks — which is what a
// composer should show for `npm run build` or a path with underscores in it. Last
// of all, so the prose cleanups cannot reach inside it either. `?? _m` for the same
// reason as the escape restore: an index nothing parked must not become the literal
// word "undefined".
function restoreSpans(text: string, spans: string[]): string {
  return text.replace(CODE_SENTINEL, (_m, i: string) => spans[Number(i)] ?? _m);
}

// Emphasis. Longest run first — `***x***` must not be read as `*` + `**x**`. The
// inner character class forbids the marker itself, which is what stops a run
// spanning from one word's emphasis to another's.
//
// Every rule also carries CommonMark's FLANKING condition: a run only opens when
// the character after it is not whitespace, and only closes when the character
// before it is not whitespace. Without it a pair of asterisks used as
// multiplication is read as emphasis and DELETED — `2 * 3 and 4 * 5` came out as
// `2  3 and 4  5`, losing two operators from a post that prompt.txt promises will
// keep every number exactly as given. It is the same class of false positive as
// snake_case, which the `_` rule guards against; the `*` rules simply never got
// the same care.
//
// Applied ONCE each, the group cannot flatten NESTED emphasis, and it fails in
// only one of the two directions — which is why it survived so long. `[^*]*`
// forbids a marker inside the run, so on `**shipped the *new* collector**` the
// `**` rule finds nothing; the `*` rule then takes `*new*`, but `**` has had its
// turn and the outer pair reaches the composer as literal asterisks. The reverse
// nesting `*a **b** c*` works, because there the rule that runs first is the one
// whose markers are innermost.
//
// Re-running the whole group until the string stops changing fixes both
// directions without loosening the flanking conditions, which is what keeps the
// arithmetic and snake_case cases out of it: a rule that matched nothing on the
// first pass matches nothing on the second either, so the loop is a no-op on text
// with no emphasis in it. It terminates because every rewrite deletes at least
// two characters, so a changed string is strictly shorter than the one before it.
function stripEmphasis(text: string): string {
  let s = text;
  for (let prev = ""; s !== prev; ) {
    prev = s;
    s = s
      .replace(/\*\*\*(?![\s*])([^*]*[^\s*])\*\*\*/g, "$1")
      .replace(/___(?![\s_])([^_]*[^\s_])___/g, "$1")
      .replace(/\*\*(?![\s*])([^*]*[^\s*])\*\*/g, "$1")
      .replace(/__(?![\s_])([^_]*[^\s_])__/g, "$1")
      .replace(/\*(?![\s*])([^*]*[^\s*])\*/g, "$1")
      // `_italic_` only at a word boundary: snake_case_names are ordinary words
      // in this corpus (file paths, identifiers) and must survive intact.
      .replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:!?]|$)/g, "$1$2")
      // ~~struck~~ text was still written; the reader should still see it. Same
      // flanking condition, for the same reason as the rules above.
      .replace(/~~(?![\s~])([^~]*[^\s~])~~/g, "$1");
  }
  return s;
}

function flattenInline(s: string): string {
  const escaped: string[] = [];
  const linked = (
    s
      // Code spans are already parked on sentinels by the time this runs — see
      // parkSpans, which the caller applies before the LINE rules, not here.
      .replace(/\\([\\`*_{}[\]()#+\-.!~>])/g, (_m, ch: string) => {
        escaped.push(ch);
        return `${ESC_OPEN}${escaped.length - 1}${ESC_OPEN}`;
      })
      // Images before links: the syntax differs only by the leading `!`, and a
      // link rule applied first would leave a stray `!` where the image was.
      // Alt text is what a reader would have been told, so it is what is kept.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      // `[label](url)` -> `label (url)`, matching how the old HTML path spelled
      // an anchor out. A link whose label already IS the url is not doubled.
      .replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, label: string, url: string) => {
        const shown = label.trim();
        return !shown || shown === url ? url : `${shown} (${url})`;
      })
      // <https://x.dev> autolinks carry no label at all.
      .replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1")
  );
  return (
    // Emphasis is the one group that has to run to a FIXED POINT rather than once
    // through — see stripEmphasis for why, and for why looping cannot loosen it.
    stripEmphasis(linked)
      // The escapes come back as the characters they were always meant to be. The
      // `?? _m` is not dead: a draft can CONTAIN a sentinel — the author pastes one,
      // and the draft round-trips through the database — and an index nothing parked
      // resolves to undefined, which `replace` stringifies into the literal word
      // "undefined" in the post. Leaving the token as written is the honest failure.
      .replace(new RegExp(`${ESC_OPEN}(\\d+)${ESC_OPEN}`, "g"), (_m, i: string) => escaped[Number(i)] ?? _m)
  );
}

function flattenLine(line: string): string {
  // Horizontal rules carry no words at all, so they leave nothing behind.
  if (
    /^[ \t]*(?:\*[ \t]*){3,}$/.test(line) ||
    /^[ \t]*(?:-[ \t]*){3,}$/.test(line) ||
    /^[ \t]*(?:_[ \t]*){3,}$/.test(line)
  ) {
    return "";
  }
  let s = line;
  // Blockquote markers, however many levels deep.
  s = s.replace(/^[ \t]*(?:>[ \t]?)+/, "");
  // ATX headings lose the hashes and keep the words. A post has no headings, but
  // a heading in a draft is still a line the author wrote.
  s = s.replace(/^[ \t]*#{1,6}[ \t]+/, "").replace(/[ \t]+#+[ \t]*$/, "");
  // List markers are NORMALISED, not removed: `- item` reads correctly in a
  // composer and is what the old HTML path produced for <li>. Indentation is
  // preserved so a nested list still looks nested.
  const bullet = s.match(/^([ \t]*)[*+-][ \t]+(.*)$/);
  if (bullet) return `${bullet[1]}- ${bullet[2]}`;
  const ordered = s.match(/^([ \t]*)(\d+)[.)][ \t]+(.*)$/);
  if (ordered) return `${ordered[1]}${ordered[2]}. ${ordered[3]}`;
  return s;
}

// Inline rules run over a PARAGRAPH, not a line. They used to run inside
// flattenLine, once per line, so a run could never be matched across a soft line
// break however the character classes were written: `**bold across\nlines**` was
// two lines, each holding one unmatched `**`. CommonMark allows emphasis to span a
// soft break, and the editor's own highlighter renders it bold — so the author saw
// bold and the post shipped asterisks.
//
// A paragraph is the right unit rather than the whole segment, because emphasis may
// NOT span a blank line: `**a\n\nb**` is two paragraphs and four literal asterisks,
// and running the rules over the joined segment would silently join them.
// Matched against ALREADY-flattened lines, where flattenLine has normalised every
// bullet to `- ` and kept ordered markers as written.
const STARTS_ITEM = /^[ \t]*(?:- |\d+[.)] )/;
function flattenParagraphs(lines: string[]): string[] {
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(...flattenInline(para.join("\n")).split("\n"));
    para = [];
  };
  for (const line of lines) {
    if (!line.trim()) {
      flush();
      out.push(line);
      continue;
    }
    // A list item is its own block, so emphasis cannot run from one item into the
    // next — CommonMark ends the paragraph at the item boundary with no blank line
    // needed. Treating a tight list as one paragraph let `- one *a` and `- two b* c`
    // pair across the boundary: both asterisks were eaten, and because the pair
    // MATCHED, residualMarkers had nothing left to warn about. Silent, and a tight
    // bullet list is the shape a generated draft usually has.
    if (STARTS_ITEM.test(line)) flush();
    para.push(line);
  }
  flush();
  return out;
}

// Markdown in, the exact bytes a social composer should receive out.
export function flattenMd(md: string): string {
  const parts = splitFences(md).map((part) => {
    if (part.code) return { code: true, text: part.text.replace(/\n+$/, "") };
    // Before the line rules, not after: a code span may cross a line break, and
    // everything below this point works a line at a time. See parkSpans.
    const spans: string[] = [];
    const lines = parkSpans(part.text, spans).split("\n");
    // A setext underline (=== or ---) belongs to the line above it, which the
    // heading rules never see because it is on its own line. Drop the underline
    // and keep the title. Checked before flattenLine so `---` is not first
    // mistaken for a horizontal rule.
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const next = lines[i + 1];
      if (lines[i].trim() && next !== undefined && /^[ \t]*(?:={2,}|-{2,})[ \t]*$/.test(next)) {
        out.push(flattenLine(lines[i]));
        i++;
        continue;
      }
      out.push(flattenLine(lines[i]));
    }
    // Collapse the blank runs the stripping leaves behind — a removed rule or
    // heading turns one blank line into three. Scoped to THIS prose segment: run
    // over the joined document it reaches inside the fences, where a blank run
    // and a trailing space are content, not residue. A segment boundary is a
    // fence, so there is no blank run spanning one to collapse.
    return {
      code: false,
      text: restoreSpans(
        flattenParagraphs(out).join("\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n"),
        spans,
      ),
    };
  });
  // Trim the document's outer whitespace, but only where the edge is prose. A
  // draft that opens or closes with a code block keeps that block's own leading
  // indentation and blank lines — trimming the joined string would eat them.
  const first = parts[0];
  if (first && !first.code) first.text = first.text.replace(/^\s+/, "");
  const last = parts[parts.length - 1];
  if (last && !last.code) last.text = last.text.replace(/\s+$/, "");
  return parts.map((p) => p.text).join("");
}

// Whether a share target can take this draft, and why not. Lifted out of the
// button so the DECISION is testable: the counting underneath it was pinned but
// the rule built on it was not, and the rule is the part a user actually hits.
//
// `soft` marks a limit we cannot verify for this user's server — a Mastodon
// instance chooses its own, and the default is only a default. Refusing a post the
// instance would have accepted is the worse error, so a soft limit warns and leaves
// the button live.
export interface ShareLimit {
  limit: number;
  soft?: boolean;
  urlOnly?: boolean;
  count?: (text: string) => number;
}
export function shareState(
  target: ShareLimit,
  text: string,
  url: string | null,
): { n: number; tooLong: boolean; noUrl: boolean; disabled: boolean; warn: boolean } {
  const n = (target.count ?? countGraphemes)(text);
  const tooLong = n > target.limit;
  const noUrl = Boolean(target.urlOnly) && !url;
  return { n, tooLong, noUrl, disabled: (tooLong && !target.soft) || noUrl, warn: tooLong && Boolean(target.soft) };
}

// The Markdown with its code taken out — fenced blocks dropped, code spans blanked.
// Two callers below need this and both need it for the same reason: what sits inside
// code is a string the author is QUOTING, not prose the app may act on. Neither can
// get it from `flattenMd`, which restores fences verbatim on purpose, so by the time
// text comes out of it a fenced `https://…` and a written-out link are the same bytes.
function dropCode(md: string): string {
  return splitFences(md)
    .filter((p) => !p.code)
    .map((p) => p.text)
    .join("\n")
    .replace(/(?<!\\)(`+)[\s\S]+?(?<!\\)\1/g, " ");
}

// Markers still standing after flattening. Every emphasis rule needs a matched
// pair, so `**shipped the collector` — an author who started a bold run and never
// closed it — passes through and reaches LinkedIn as literal asterisks.
//
// Deliberately a warning and not a repair. Stripping a lone marker would have to
// guess: `2 * 3`, a footnote `*`, `snake_case` and an arithmetic underscore are
// all legitimate text a "clean up the strays" pass would eat, and silently
// editing someone's post to fix their typo is worse than showing them the typo.
//
// Takes the MARKDOWN, not the flattened text, because by then code spans and
// fences have been restored verbatim and their markers are indistinguishable from
// unclosed ones. `**kwargs` inside a code span is correct text the author cannot
// change without breaking the code they meant to quote, and a warning pointing at
// it is the false-positive version of the false repair this function exists to
// avoid. Code is dropped here rather than flattened, and so are backslash escapes:
// `\*` is a literal asterisk the author asked for on purpose.
/**
 * True when a link still carries the Link button's placeholder target.
 *
 * The button inserts `[label](https://)` so the caret lands somewhere useful, and
 * nothing downstream objects if the author never fills it in: `flattenMd` spells
 * the link out as `label (https://)`, which is well-formed, and `residualMarkers`
 * sees no unpaired marker because the brackets and parens are all matched. So an
 * unfinished link reaches the composer looking deliberate.
 *
 * Read from the SOURCE and with code dropped, like `residualMarkers` — `](https://)`
 * inside a fence is someone quoting this syntax, not leaving a blank.
 */
export function hasPlaceholderLink(md: string): boolean {
  return /\]\(\s*(?:https?:\/\/)?\s*\)/.test(dropCode(md));
}

export function residualMarkers(md: string): string[] {
  const prose = dropCode(md).replace(/\\[\\`*_{}[\]()#+\-.!~>]/g, " ");
  // Flattening consumes every matched pair, so whatever survives is unpaired.
  // What counts as a stray is a run in OPENER position — at the start, or after
  // whitespace or `(` — with a non-space after it. That is CommonMark's
  // left-flanking test, the same condition the rules themselves use, and it is
  // what keeps the warning off the text it has no business flagging: `2 * 3` has a
  // space after the asterisk, a trailing footnote `*` has nothing after it, and
  // `snake_case`'s underscore is mid-word rather than in opener position.
  //
  // Single `*` and `_` are included. Only `**`/`__`/`~~` were checked before, so
  // `*italic across` — a whole unclosed italic run — reached the composer with the
  // asterisk visible and nothing on screen saying so.
  //
  // It is not free of false positives: a leading glob like `*.ts` written outside
  // backticks reads as an opener and will be flagged. That is the acceptable
  // direction — the warning changes nothing about the draft, and prompt.txt asks
  // for identifiers in backticks, which this function already excludes.
  const flat = flattenMd(prose);
  const found = new Set<string>();
  for (const m of flat.matchAll(/(?:^|[\s(])(\*{1,3}|_{1,3}|~{2})(?=[^\s*_~])/g)) found.add(m[1]);
  // The EMPTY pair, which the scan above cannot see: `****` is an opener followed
  // immediately by its own closer, so the character after the run is another marker
  // and the lookahead rejects it. Nothing flattens it either — every emphasis rule
  // requires `[^*]*[^\s*]`, at least one non-space character inside the run — so it
  // reaches the composer as four literal asterisks. It is the one a toolbar produces
  // by accident rather than a typo: Bold with no selection inserts `****` at the
  // caret.
  //
  // Matched as a RUN OF FOUR OR MORE rather than by letting the lookahead accept a
  // repeated marker, which is the version that looks simpler and is wrong: with
  // `(?=[^\s*_~]|\1)` the single-`*` alternative matches the first asterisk of
  // `2 ** 3`, so Python's power operator — and any bare `**` in prose — becomes a
  // warning. Four is what an empty pair actually costs. On its own line a run of
  // three or more is a thematic break and correctly flattens to nothing before this
  // runs, so only the mid-sentence case is left to report.
  for (const m of flat.matchAll(/(?:^|[\s(])([*_~])\1{3,}(?![*_~])/g)) found.add(m[1].repeat(2));
  return [...found];
}

// An href safe to put on an <a>. javascript:/data: URLs are the whole reason this
// exists — an anchor with a script URL is still script execution, one click later.
export function safeHref(url: string): string | null {
  const u = url.trim();
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (/^[/#]/.test(u)) return u; // same-origin relative
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return null; // some other scheme — refuse
  return `https://${u}`; // bare domain
}

// First URL in the post — Facebook's sharer only accepts a link, so this is what
// it gets when the post mentions one. Takes the MARKDOWN and drops the code first,
// then flattens: a url inside `[label](url)` is a real link to share, and one
// inside a fence or a code span is a string literal that is not. Scanning the
// flattened text instead read them as equals, so a draft whose only url was a
// `curl https://api.internal/x` line enabled the Facebook button and shared that
// host.
export function firstUrl(md: string): string | null {
  return flattenMd(dropCode(md)).match(/https?:\/\/[^\s)]+/)?.[0] ?? null;
}

// The Markdown a draft should start from, for a draft written before Markdown
// was the stored format. Plain text IS valid Markdown, and `text` on those rows
// was produced by the old htmlToText — which already spelled links out as
// `label (url)` — so taking it verbatim loses nothing. `html` is dropped: on
// this corpus it was `<br>`-joined copies of `text` in every row but one, and
// that one's only markup was an anchor `text` already carries.
export function draftMd(draft: { md?: string | null; text?: string | null }): string {
  return draft.md ?? draft.text ?? "";
}

// Applied to every draft row as it is read, so a pre-Markdown draft becomes a
// `{ angle, md }` one at the door and the rest of the app never meets the old
// shape. Doing it only where a draft is DISPLAYED is not enough: an edit saves
// the whole array, so a legacy draft sitting untouched beside the edited one
// travelled to the API still carrying `text` and no `md`, and the server — which
// requires `md` on every element — rejected the entire save. Editing any draft in
// such a row failed, and the card you were typing in said SAVE FAILED.
export function normalizeDrafts(drafts: Array<{ angle?: string | null; md?: string | null; text?: string | null }>): Array<{
  angle: string;
  md: string;
}> {
  return drafts.map((d) => ({ angle: d.angle ?? "", md: draftMd(d) }));
}

// Built once. Constructing a Segmenter is the expensive part — segmenting a
// 300-character draft is not — and this sits on the per-keystroke path: the header
// count plus a shareState call for every target is seven counts per card, per
// render. The try/catch stays around the CONSTRUCTION, which is the only thing that
// throws (an engine without Intl.Segmenter), so the code-point fallback behaves
// exactly as it did.
const GRAPHEMES: Intl.Segmenter | null = (() => {
  try {
    return new Intl.Segmenter(undefined, { granularity: "grapheme" });
  } catch {
    return null;
  }
})();

// --- Counting ----------------------------------------------------------------
// What a network thinks the length is. `String.length` counts UTF-16 code units,
// which no composer here uses, and the difference stopped being cosmetic once the
// count started DISABLING a button: a draft the network would accept is refused
// locally, with no way to override it.
//
// Graphemes, not code points: a single emoji is routinely 2+ code units and can be
// several code points joined with ZWJ, and Bluesky counts what the reader sees.
// Intl.Segmenter is the only correct way to ask, and the code-point fallback is
// still closer than `.length` where it is missing.
export function countGraphemes(text: string): number {
  if (!GRAPHEMES) return [...text].length; // code points — wrong for ZWJ sequences, right for the rest
  let n = 0;
  for (const _ of GRAPHEMES.segment(text)) n++;
  return n;
}

// X replaces every URL with a t.co short link before counting, so a link costs 23
// no matter how long it is. Flattening spells links out as `label (url)`, which makes
// long URLs the normal case in this app rather than an edge one — counting them
// literally is what blocks a 340-char draft that X would measure at ~253.
const TCO_LENGTH = 23;
export function countForX(text: string): number {
  return countGraphemes(text.replace(/https?:\/\/[^\s)]+/g, "x".repeat(TCO_LENGTH)));
}

// A bare hostname, for the Mastodon instance the user types. It is deliberately not a
// URL parser: the value is interpolated into `https://<host>/share`, so anything with a
// scheme, a path, a space or an empty label must not reach it.
//
// This cannot catch a TYPO in a plausible host — `mastodon.socail` is a well-formed
// hostname that does not exist, and no local check will ever say otherwise. It catches
// the shapes that could never work; the UI's edit affordance is what fixes the rest.
export function isHostname(host: string): boolean {
  return /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(host);
}

// The last line number a selection covers. A selection dragged down through whole
// lines ends at the FIRST position of the line after the last one it covers, and
// `lineAt(to)` then names a line the user did not select — so a list transform put
// a bullet on it. Pure, and separate from prefixLines, because prefixLines needs a
// live EditorView and this is the part that was wrong.
//
// `to > from` keeps a caret at a line start naming its own line: an empty selection
// is a single line, not zero lines.
export function lastSelectedLine(
  from: number,
  to: number,
  lineAtTo: { number: number; from: number },
): number {
  return to > from && lineAtTo.from === to ? lineAtTo.number - 1 : lineAtTo.number;
}

/** What a toolbar wrap button should change, decided without an editor. */
export interface WrapEdit {
  from: number;
  to: number;
  insert: string;
  /** Where the selection should land afterwards — the text, never the markers. */
  anchor: number;
  head: number;
}

// Bold on already-bold text has to UNBOLD it. Inserting unconditionally produced
// `****text****`, which no emphasis rule consumes — each one needs a non-marker,
// non-space character straight after the opening run — so it reached the composer
// as eight literal asterisks. The `execCommand` toolbar this replaced toggled, and
// that was the one behaviour the rewrite changed without meaning to.
//
// The markers can sit on either side of the selection boundary, and which one the
// author produces depends on how they made the selection: double-clicking the word
// inside `**text**` selects `text` and leaves the markers outside it, while dragging
// across the whole run selects them too. Both are the same intent.
//
// A run of the SAME marker character just inside the pair is not a toggle: pressing
// Italic on a selected `**bold**` means bold AND italic, so the inner `*bold*` guard
// sends it down the insert path and yields `***bold***` rather than eating a level
// of emphasis the author did not ask about.
export function wrapEdit(doc: string, from: number, to: number, before: string, after: string): WrapEdit {
  const selected = doc.slice(from, to);
  const marker = before[before.length - 1];
  const inside =
    selected.length >= before.length + after.length && selected.startsWith(before) && selected.endsWith(after)
      ? selected.slice(before.length, selected.length - after.length)
      : null;
  if (inside !== null && !inside.startsWith(marker) && !inside.endsWith(marker)) {
    return { from, to, insert: inside, anchor: from, head: from + inside.length };
  }
  const outer = from - before.length;
  if (outer >= 0 && doc.slice(outer, from) === before && doc.slice(to, to + after.length) === after) {
    return { from: outer, to: to + after.length, insert: selected, anchor: outer, head: outer + selected.length };
  }
  return {
    from,
    to,
    insert: `${before}${selected}${after}`,
    anchor: from + before.length,
    head: from + before.length + selected.length,
  };
}

// What a list-toolbar button should leave one line as. The emphasis buttons toggle
// through wrapEdit; these used to insert unconditionally, so pressing "• List" on
// `- item` gave `- - item` and "1. List" on `1. one` gave `1. 1. one`. Both reach
// the composer literally — flattenLine matches the OUTER marker and keeps the rest
// of the line as the item's body — so the doubled marker is in the post.
//
// Pressing the button a line already has removes that marker; pressing the OTHER
// button switches the line between the two kinds, which is what a reader of a
// toolbar expects and is otherwise a delete-then-retype. Indentation is preserved
// either way, because a nested item that jumps to column 0 has left its list.
export interface ListEdit {
  text: string;
  /** Whether `prefix` ended up in the line. False on the removal branch, which is
   *  what an ordered-list counter has to know — see listEdits. */
  inserted: boolean;
}
export function listLine(text: string, prefix: string): ListEdit {
  const bullet = /^([ \t]*)([*+-][ \t]+)/.exec(text);
  const ordered = /^([ \t]*)(\d+[.)][ \t]+)/.exec(text);
  const has = bullet ?? ordered;
  const wantOrdered = /^\d+[.)]\s/.test(prefix);
  if (has) {
    const rest = text.slice(has[1].length + has[2].length);
    // Same kind as the button pressed — take it off. Different kind — swap it.
    const same = Boolean(ordered) === wantOrdered;
    return { text: has[1] + (same ? "" : prefix) + rest, inserted: !same };
  }
  const indent = /^[ \t]*/.exec(text)?.[0] ?? "";
  return { text: indent + prefix + text.slice(indent.length), inserted: true };
}

export interface LineEdit {
  /** Index into the lines passed in, so the caller can map back to document offsets. */
  index: number;
  text: string;
}

/**
 * The whole decision behind a list button: which of the selected lines change, what
 * each becomes, and how the ordered numbering runs across them.
 *
 * A number is consumed only where the prefix actually lands. Two ways it does not:
 * a blank line inside a multi-line block is skipped entirely, and a line that
 * already carries this kind of marker has it REMOVED. Advancing the counter on
 * either misnumbers the rest — `1. one` and `two` under "1. List" came out as
 * `one` / `2. two`, because the removal had already consumed prefix(0).
 */
export function listEdits(lines: string[], prefix: (i: number) => string): LineEdit[] {
  const edits: LineEdit[] = [];
  let i = 0;
  lines.forEach((text, index) => {
    // Don't bullet the blank lines in a block; a single blank line IS the selection,
    // so leaving it alone would make the button do nothing at all.
    if (!text.trim() && lines.length > 1) return;
    const edit = listLine(text, prefix(i));
    if (edit.inserted) i++;
    edits.push({ index, text: edit.text });
  });
  return edits;
}
