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

