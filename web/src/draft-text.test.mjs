// Node test for the draft text helpers. The DOM walk decides what actually gets
// pasted into a social composer, so it is worth pinning down; a stub node is
// enough since htmlToText only reads nodeType/childNodes/tagName/getAttribute.
import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToText, textToHtml, firstUrl, sanitizeElement, safeHref } from "./draft-text.ts";

globalThis.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };

const t = (text) => ({ nodeType: 3, textContent: text, childNodes: [] });
const el = (tagName, childNodes = [], attrs = {}) => ({
  nodeType: 1,
  tagName,
  childNodes,
  getAttribute: (k) => attrs[k] ?? null,
});

test("a link's href is spelled out when it differs from the anchor text", () => {
  const root = el("DIV", [
    t("Shipped "),
    el("A", [t("the writeup")], { href: "https://itguys.ro/p" }),
    t(" today"),
  ]);
  assert.equal(htmlToText(root), "Shipped the writeup (https://itguys.ro/p) today");
});

test("a bare-URL link is not duplicated", () => {
  const root = el("DIV", [
    el("A", [t("https://itguys.ro/p")], { href: "https://itguys.ro/p" }),
  ]);
  assert.equal(htmlToText(root), "https://itguys.ro/p");
});

test("whitespace the anchor swallowed stays outside the parenthetical", () => {
  // A double-click selection normally takes the trailing space with it.
  const root = el("DIV", [
    t("on my "),
    el("A", [t("activity ")], { href: "https://itguys.ro/p" }),
    t("collector."),
  ]);
  assert.equal(htmlToText(root), "on my activity (https://itguys.ro/p) collector.");
});

test("blocks, breaks and list items become newlines", () => {
  const root = el("DIV", [
    el("DIV", [t("Line one")]),
    el("DIV", [t("Line two"), el("BR"), t("still two")]),
    el("UL", [el("LI", [t("first")]), el("LI", [t("second")])]),
  ]);
  assert.equal(htmlToText(root), "Line one\nLine two\nstill two\n- first\n- second");
});

test("runs of blank lines collapse to one", () => {
  const root = el("DIV", [
    el("DIV", [t("top")]),
    el("DIV", [el("BR")]),
    el("DIV", [el("BR")]),
    el("DIV", [t("bottom")]),
  ]);
  assert.equal(htmlToText(root), "top\n\nbottom");
});

test("textToHtml escapes markup and keeps blank lines", () => {
  assert.equal(textToHtml("a <b> & c\n\nnext"), "a &lt;b&gt; &amp; c<br><br><br>next");
});

test("firstUrl finds a url and ignores a trailing paren", () => {
  assert.equal(firstUrl("see the post (https://itguys.ro/p) today"), "https://itguys.ro/p");
  assert.equal(firstUrl("no links here"), null);
});

// --- sanitizer -------------------------------------------------------------
// The editor is seeded via dangerouslySetInnerHTML from a value that has been
// through the API and the DB, so these are the cases that decide whether a
// stored draft can run script in the browser.

test("script elements are dropped along with their contents", () => {
  const root = el("DIV", [t("hi "), el("SCRIPT", [t("alert(1)")]), t(" there")]);
  assert.equal(sanitizeElement(root), "hi  there");
});

test("an unknown element is dropped but its text survives", () => {
  const root = el("DIV", [el("IMG", []), el("MARQUEE", [t("kept")])]);
  assert.equal(sanitizeElement(root), "kept");
});

test("event-handler attributes are never emitted", () => {
  const root = el("DIV", [el("B", [t("bold")], { onclick: "alert(1)", style: "x" })]);
  assert.equal(sanitizeElement(root), "<b>bold</b>");
});

test("a javascript: href loses the anchor but keeps the text", () => {
  const root = el("DIV", [el("A", [t("click")], { href: "javascript:alert(1)" })]);
  assert.equal(sanitizeElement(root), "click");
});

test("an http link keeps its href and gains noopener", () => {
  const root = el("DIV", [el("A", [t("post")], { href: "https://itguys.ro/p" })]);
  assert.equal(
    sanitizeElement(root),
    '<a href="https://itguys.ro/p" target="_blank" rel="noopener noreferrer">post</a>'
  );
});

test("text is escaped, so markup in a draft stays text", () => {
  const root = el("DIV", [el("P", [t('<img src=x onerror="alert(1)"> & "q"')])]);
  assert.equal(
    sanitizeElement(root),
    "<p>&lt;img src=x onerror=\"alert(1)\"&gt; &amp; \"q\"</p>"
  );
});

test("safeHref: bare domain gets https, other schemes refused", () => {
  assert.equal(safeHref("itguys.ro"), "https://itguys.ro");
  assert.equal(safeHref("https://itguys.ro"), "https://itguys.ro");
  assert.equal(safeHref("mailto:a@b.c"), "mailto:a@b.c");
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("data:text/html,<script>"), null);
});

test("a script's source text never reaches the post body", () => {
  const root = el("DIV", [
    t("today"),
    el("SCRIPT", [t("alert(1)")]),
    el("STYLE", [t("b{color:red}")]),
  ]);
  assert.equal(htmlToText(root), "today");
});
