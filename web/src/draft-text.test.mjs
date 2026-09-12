// Node test for the draft text helpers. The DOM walk decides what actually gets
// pasted into a social composer, so it is worth pinning down; a stub node is
// enough since htmlToText only reads nodeType/childNodes/tagName/getAttribute.
import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToText, textToHtml, firstUrl } from "./draft-text.ts";

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
