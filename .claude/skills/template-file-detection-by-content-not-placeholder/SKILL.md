---
name: template-file-detection-by-content-not-placeholder
description: |
  Detect/skip unfilled template or boilerplate files (Obsidian/Templater notes,
  scaffold docs, daily-note skeletons) when ingesting/collecting/indexing them —
  e.g. a note collector, RAG ingest, or dataset cleaner that wants to drop empty
  template stubs. Use when writing a filter that classifies a file as "just a
  template" so it can be excluded. GOTCHA: classifying by presence of a placeholder
  token (regex /\{\{...\}\}/, `<% %>`, `${...}`) silently drops REAL content —
  GitHub Actions exprs `${{ inputs.x }}` and notes that merely *document* template
  syntax ("templates use {{date}}") match the regex. Fix: measure real content
  AFTER stripping structure, don't pattern-match the token.
author: Claude Code
version: 1.0.0
date: 2026-06-09
---

# Template-file detection: measure content, don't match the placeholder token

## Problem
A collector/indexer wants to skip unfilled template files (empty daily-note
skeletons, scaffold stubs). The obvious filter — "skip any file whose body
contains `{{...}}`" — is wrong and causes **silent data loss**.

## Context / Trigger Conditions
You are writing a filter to exclude template/boilerplate files, and reach for a
placeholder-token test like:
- `if (/\{\{[^}]*\}\}/.test(content)) skip;`  (Obsidian/Handlebars/Mustache)
- `<% ... %>` (Templater/EJS), `${...}`, `__PLACEHOLDER__`, etc.

False positives that get wrongly dropped:
1. **Real notes containing GitHub Actions expressions** — `runs-on: ${{ inputs.runner }}`
   contains `{{ }}` and matches the regex.
2. **Notes that document template syntax** — prose like "templates use `{{date}}` for
   date insertion" matches too.
Both are content-rich files (saw 2970- and 3280-char notes silently dropped).

## Solution
Classify by **how much real content remains after stripping structure**, not by
whether a placeholder token appears. Strip the scaffold, then measure:

```ts
const MIN_REAL_CONTENT = 20; // tune per corpus
function realContentLength(content: string): number {
  return content
    .replace(/^---\n[\s\S]*?\n---/, "")      // YAML frontmatter block
    .replace(/^#{1,6}\s.*$/gm, "")           // markdown headings
    .replace(/^[-*]\s*\[[ x]\]\s*$/gm, "")   // empty checkboxes
    .replace(/^[-*]\s*$/gm, "")              // bare bullets
    .replace(/\{\{[^}]*\}\}/g, "")           // template placeholders
    .replace(/\s+/g, "").length;             // remaining non-whitespace chars
}
// skip only genuinely-empty skeletons:
if (realContentLength(content) < MIN_REAL_CONTENT) continue;
```

The key inversion: a placeholder token is fine in a real file; what marks a
template is that **nothing of substance is left once you remove headings,
frontmatter, empty list items, and the placeholders themselves.**

## Verification
Run the filter over the whole corpus and print KEEP vs SKIP with the file name and
its `realContentLength`. Confirm:
- genuinely-empty stubs (0 real chars) → SKIP
- real files that merely mention `{{ }}` / `${{ }}` → KEEP
Across a 61-file Obsidian vault this kept 58 (incl. a CI-runners note with
`${{ inputs.runner }}` and a CLAUDE.md documenting `{{date}}`) and skipped only the
2 empty `Daily Note.md` / `Project.md` skeletons.

## Notes
- Generalizes beyond Obsidian: any boilerplate/scaffold detector (cookiecutter,
  Handlebars/Mustache/EJS, JSON/YAML config stubs). Adjust the strip rules to the
  format's structural noise; the principle (strip-then-measure) is constant.
- `MIN_REAL_CONTENT` is corpus-dependent — start ~20 chars, eyeball the KEEP/SKIP
  split, adjust. Too high drops sparse-but-real notes.
- Watch the related trap: `${{ }}` (GitHub Actions) vs `{{ }}` (templating) collide
  under a naive regex. If you ever DO need token-matching, exclude `$`-prefixed:
  `/(^|[^$])\{\{[^}]*\}\}/` — but prefer strip-then-measure.
- Silent data loss is the real danger: a too-broad skip filter reads as "covered
  everything" while quietly dropping rows. Log SKIP counts + names during dev.
