import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { config } from "dotenv";
import { insertItems, expandHome, type ItemInput } from "./db";

config();

const VAULT_PATH = expandHome(process.env.VAULT_PATH ?? "~/obsidian.md");

// Directories never worth scanning inside a vault.
const SKIP_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules"]);

// Cap stored body so a huge note can't bloat the DB or the generation prompt.
const MAX_BODY = 4000;

async function walkMarkdown(dir: string, out: string[]): Promise<void> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir — skip quietly
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walkMarkdown(full, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      out.push(full);
    }
  }
}

// An unfilled template note has negligible content once frontmatter, headings,
// empty checkboxes, bare bullets and {{...}} placeholders are stripped. This is
// content-based, not a bare {{...}} match — real notes mention `${{ }}` (GitHub
// Actions) or document `{{date}}` syntax and must NOT be skipped.
const MIN_REAL_CONTENT = 20;
function realContentLength(content: string): number {
  return content
    .replace(/^---\n[\s\S]*?\n---/, "") // frontmatter block
    .replace(/^#{1,6}\s.*$/gm, "") // headings
    .replace(/^[-*]\s*\[[ x]\]\s*$/gm, "") // empty checkboxes
    .replace(/^[-*]\s*$/gm, "") // bare bullets
    .replace(/\{\{[^}]*\}\}/g, "") // template placeholders
    .replace(/\s+/g, "").length;
}

// First markdown heading, else the filename without extension.
function deriveTitle(content: string, file: string): string {
  const m = content.match(/^#{1,6}\s+(.+)$/m);
  if (m) return m[1].trim();
  return path.basename(file, path.extname(file));
}

export async function collectObsidian(): Promise<number> {
  const files: string[] = [];
  await walkMarkdown(VAULT_PATH, files);

  const rows: ItemInput[] = [];
  for (const file of files) {
    let content: string;
    let mtimeMs: number;
    try {
      const stat = await fs.stat(file);
      mtimeMs = stat.mtimeMs;
      content = await fs.readFile(file, "utf8");
    } catch {
      continue; // OneDrive placeholder / permission error — skip
    }
    // Cloud-only placeholder files read empty; nothing to capture.
    if (content.trim().length === 0) continue;
    // Unfilled template notes are near-empty skeletons — pure noise, skip them.
    if (realContentLength(content) < MIN_REAL_CONTENT) continue;

    // contentHash makes dedup robust to OneDrive mtime drift: same path+content = one item.
    const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
    const rel = path.relative(VAULT_PATH, file);
    rows.push({
      source: "obsidian",
      external_id: `${rel}:${hash}`,
      title: deriveTitle(content, file),
      body: content.slice(0, MAX_BODY),
      url: null,
      occurred_at: new Date(mtimeMs).toISOString(),
      raw_json: JSON.stringify({ path: rel }),
    });
  }
  return insertItems(rows);
}
