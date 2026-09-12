// Pure text helpers for the draft editor. Kept out of App.tsx so they can be
// exercised directly (see draft-text.test.mjs) — the DOM walk is the part that
// decides what actually lands in a social composer.

// Social composers take PLAIN TEXT, not HTML — so the rich markup is only ever a
// local convenience and the text is the artifact. Flatten block elements to
// newlines, and spell out a link's href whenever it isn't already the anchor's
// own text: <a href="https://x.dev">my post</a> becomes "my post (https://x.dev)",
// which is the only form that survives a paste into LinkedIn or X.
export function htmlToText(root: HTMLElement): string {
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as HTMLElement;
    const inner = Array.from(el.childNodes).map(walk).join("");
    switch (el.tagName) {
      case "BR":
        return "\n";
      case "A": {
        const href = el.getAttribute("href") ?? "";
        const shown = inner.trim();
        if (!href || shown === href) return inner;
        // Keep whatever whitespace the anchor swallowed OUTSIDE the parenthetical.
        // A double-click selection usually includes the trailing space, and
        // appending blindly gives "activity  (url)collector."
        const lead = inner.slice(0, inner.length - inner.trimStart().length);
        const trail = inner.slice(inner.trimEnd().length);
        return `${lead}${shown} (${href})${trail}`;
      }
      case "LI":
        return `- ${inner}\n`;
      case "P":
      case "DIV":
      case "UL":
      case "OL":
        return inner.endsWith("\n") ? inner : `${inner}\n`;
      default:
        return inner;
    }
  };
  return walk(root).replace(/\n{3,}/g, "\n\n").trim();
}

// Seed the editor from whatever the draft already has: earlier edits (html) win,
// otherwise the generated plain text, with newlines turned into real breaks.
export function textToHtml(text: string): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text
    .split(/\n/)
    .map((line) => (line.trim() ? esc(line) : "<br>"))
    .join("<br>");
}

// First URL in the draft — Facebook's sharer only accepts a link, so this is what
// it gets when the post mentions one.
export function firstUrl(text: string): string | null {
  return text.match(/https?:\/\/[^\s)]+/)?.[0] ?? null;
}


// --- Sanitizing ------------------------------------------------------------
// The editor is seeded with dangerouslySetInnerHTML, so every path that reaches
// it is an HTML injection sink: draft.html round-trips through PUT /api/drafts/:id
// and the DB, and the server stores the string verbatim. Anything that can POST
// to the API could therefore park an <img onerror> in a draft row and have it
// fire in the browser the next time that week is opened. Sanitize at the sink —
// it is the one place every source (generated, edited, stored) converges.
//
// This builds the output from an allowlist instead of blacklisting tags, so an
// unknown element cannot slip through: an element that isn't allowed is dropped
// but its text is kept, and only the attributes named here are ever emitted.
const ALLOWED_TAGS = new Set([
  "B", "STRONG", "I", "EM", "U", "BR", "P", "DIV", "SPAN", "UL", "OL", "LI", "A",
]);
// Elements whose *contents* are not text and must go with them.
const DROP_CONTENT = new Set([
  "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "TEMPLATE", "NOSCRIPT", "SVG", "MATH",
]);
const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => escText(s).replace(/"/g, "&quot;");

// javascript:/data: hrefs are the other half of the same sink — an allowlisted
// <a> with a script URL is still script execution, just one click later.
export function safeHref(url: string): string | null {
  const u = url.trim();
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (/^[/#]/.test(u)) return u; // same-origin relative
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return null; // some other scheme — refuse
  return `https://${u}`; // bare domain the user typed
}

// Serializes a container's CONTENTS, re-emitting only what is allowed. The root
// itself is never emitted — it is the editor div (or a parsed <body>), and
// wrapping it back in would nest one more div on every save round-trip.
// Read-only on the DOM (same shape as htmlToText) so it is testable with a stub.
export function sanitizeElement(root: HTMLElement): string {
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return escText(node.textContent ?? "");
    if (node.nodeType !== Node.ELEMENT_NODE) return ""; // comments, PIs, doctype
    const el = node as HTMLElement;
    const tag = el.tagName.toUpperCase();
    if (DROP_CONTENT.has(tag)) return "";
    const inner = Array.from(el.childNodes).map(walk).join("");
    if (tag === "BR") return "<br>";
    if (!ALLOWED_TAGS.has(tag)) return inner; // unknown element: keep the text
    if (tag === "A") {
      const href = safeHref(el.getAttribute("href") ?? "");
      if (!href) return inner;
      return `<a href="${escAttr(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
    }
    return `<${tag.toLowerCase()}>${inner}</${tag.toLowerCase()}>`;
  };
  return Array.from(root.childNodes).map(walk).join("");
}

// Parse with DOMParser rather than a detached div: a document from
// parseFromString is inert, so nothing runs even while we are inspecting it.
export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return sanitizeElement(doc.body as HTMLElement);
}
