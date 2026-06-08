import Database from "better-sqlite3";
import { config } from "dotenv";
import os from "os";
import path from "path";
import { isoWeek } from "./week";

config();

// dotenv does no shell expansion, so values like "~/x" or "$HOME/x" arrive literal.
export function expandHome(p: string): string {
  const home = os.homedir();
  if (p === "~" || p.startsWith("~/")) return path.join(home, p.slice(1));
  if (p === "$HOME" || p.startsWith("$HOME/")) return path.join(home, p.slice("$HOME".length));
  return p;
}

const DB_PATH = expandHome(
  process.env.DB_PATH ?? path.join(__dirname, "..", "social.sqlite")
);

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id           INTEGER PRIMARY KEY,
    source       TEXT NOT NULL,
    external_id  TEXT NOT NULL,
    title        TEXT,
    body         TEXT,
    url          TEXT,
    occurred_at  TEXT,
    iso_week     TEXT,
    collected_at TEXT NOT NULL,
    raw_json     TEXT,
    UNIQUE(source, external_id)
  );

  CREATE INDEX IF NOT EXISTS idx_items_iso_week ON items(iso_week);

  CREATE TABLE IF NOT EXISTS drafts (
    id             INTEGER PRIMARY KEY,
    created_at     TEXT NOT NULL,
    iso_week       TEXT NOT NULL,
    input_snapshot TEXT,
    prompt_used    TEXT,
    output         TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_drafts_iso_week ON drafts(iso_week);
`);

// Shared insert path for every collector. Dedup via UNIQUE(source, external_id) + INSERT OR IGNORE.
// iso_week is derived from occurred_at so late collection files items into the week they happened.
export interface ItemInput {
  source: string;
  external_id: string;
  title?: string | null;
  body?: string | null;
  url?: string | null;
  occurred_at?: string | null; // ISO-8601; null leaves iso_week null
  raw_json?: string | null;
}

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO items
    (source, external_id, title, body, url, occurred_at, iso_week, collected_at, raw_json)
  VALUES
    (@source, @external_id, @title, @body, @url, @occurred_at, @iso_week, @collected_at, @raw_json)
`);

// Returns the number of rows actually inserted (duplicates ignored).
export function insertItems(items: ItemInput[]): number {
  const collected_at = new Date().toISOString();
  const tx = db.transaction((rows: ItemInput[]): number => {
    let inserted = 0;
    for (const r of rows) {
      const res = insertStmt.run({
        source: r.source,
        external_id: r.external_id,
        title: r.title ?? null,
        body: r.body ?? null,
        url: r.url ?? null,
        occurred_at: r.occurred_at ?? null,
        iso_week: r.occurred_at ? isoWeek(r.occurred_at) : null,
        collected_at,
        raw_json: r.raw_json ?? null,
      });
      inserted += res.changes;
    }
    return inserted;
  });
  return tx(items);
}

export default db;
