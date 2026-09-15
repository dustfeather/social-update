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
  const re = /^[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm;
  let last = 0;
  for (const m of md.matchAll(re)) {
    const start = m.index ?? 0;
    if (start > last) out.push({ code: false, text: md.slice(last, start) });
    out.push({ code: true, text: m[2] });
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
function flattenInline(s: string): string {
  const escaped: string[] = [];
  const spans: string[] = [];
  return (
    s
      // Code spans come out FIRST, before any rule that rewrites content. They used to
      // be stripped near the end, after the image/link/autolink rules had already run
      // over the whole line — so a span holding Markdown syntax was mangled rather than
      // preserved: `[a](b)` became `a (b)` and `**x**` became `x`. splitFences exists
      // because punctuation inside code is load-bearing; that argument does not stop at
      // the fence. The backreference still closes a run of N ticks with a run of N, so
      // ``a `b` c`` remains one span whose text contains ticks.
      //
      // The lookbehinds keep an escaped tick (\`) from opening or closing a span, which
      // is why this runs before the escape pass rather than after: once \` is parked on
      // a sentinel the delimiter is invisible here.
      .replace(/(?<!\\)(`+)([\s\S]+?)(?<!\\)\1/g, (_m, _ticks: string, body: string) => {
        spans.push(body);
        return `${CODE_OPEN}${spans.length - 1}${CODE_OPEN}`;
      })
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
      // Emphasis. Longest run first — `***x***` must not be read as `*` + `**x**`.
      // The inner character class forbids the marker itself, which is what stops
      // a run spanning from one word's emphasis to another's.
      .replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
      .replace(/___([^_]+)___/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/\*([^*\n]+)\*/g, "$1")
      // `_italic_` only at a word boundary: snake_case_names are ordinary words
      // in this corpus (file paths, identifiers) and must survive intact.
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, "$1$2")
      // ~~struck~~ text was still written; the reader should still see it.
      .replace(/~~([^~]+)~~/g, "$1")
      // The escapes come back as the characters they were always meant to be.
      .replace(new RegExp(`${ESC_OPEN}(\\d+)${ESC_OPEN}`, "g"), (_m, i: string) => escaped[Number(i)])
      // The span's text returns exactly as written, minus its ticks — which is what a
      // composer should show for `npm run build` or a path with underscores in it.
      .replace(new RegExp(`${CODE_OPEN}(\\d+)${CODE_OPEN}`, "g"), (_m, i: string) => spans[Number(i)])
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
  if (bullet) return `${bullet[1]}- ${flattenInline(bullet[2])}`;
  const ordered = s.match(/^([ \t]*)(\d+)[.)][ \t]+(.*)$/);
  if (ordered) return `${ordered[1]}${ordered[2]}. ${flattenInline(ordered[3])}`;
  return flattenInline(s);
}

// Markdown in, the exact bytes a social composer should receive out.
export function flattenMd(md: string): string {
  const parts = splitFences(md).map((part) => {
    if (part.code) return { code: true, text: part.text.replace(/\n+$/, "") };
    const lines = part.text.split("\n");
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
    return { code: false, text: out.join("\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n") };
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

// An href safe to put on an <a>. javascript:/data: URLs are the whole reason this
// exists — an anchor with a script URL is still script execution, one click later.
export function safeHref(url: string): string | null {
  const u = url.trim();
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (/^[/#]/.test(u)) return u; // same-origin relative
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return null; // some other scheme — refuse
  return `https://${u}`; // bare domain
}

// First URL in the flattened post — Facebook's sharer only accepts a link, so
// this is what it gets when the post mentions one. Deliberately run over the
// FLATTENED text, not the Markdown: a url inside `[label](url)` is a real link
// to share, and one inside a code fence is a string literal that is not.
export function firstUrl(text: string): string | null {
  return text.match(/https?:\/\/[^\s)]+/)?.[0] ?? null;
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
  try {
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    let n = 0;
    for (const _ of seg.segment(text)) n++;
    return n;
  } catch {
    return [...text].length; // code points — wrong for ZWJ sequences, right for the rest
  }
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
