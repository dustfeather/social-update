import Database from "better-sqlite3";
import { config } from "dotenv";
import os from "os";
import path from "path";

config();

function expandHome(p: string): string {
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
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

export default db;
