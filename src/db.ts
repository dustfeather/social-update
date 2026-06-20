import { DatabaseSync } from "node:sqlite";
import { config } from "dotenv";
import path from "path";
import { isoWeek } from "./week";
import { expandHome } from "./paths";

config();

const DB_PATH = expandHome(
  process.env.DB_PATH ?? path.join(__dirname, "..", "social.sqlite")
);

export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

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

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- One row per collection run requested from the UI button or the daily timer.
  -- The local poller claims a pending row, runs the watchdog, then reports back.
  CREATE TABLE IF NOT EXISTS collect_runs (
    id           INTEGER PRIMARY KEY,
    status       TEXT NOT NULL,        -- pending | running | done | error
    source       TEXT NOT NULL,        -- manual | daily
    requested_at TEXT NOT NULL,
    started_at   TEXT,
    finished_at  TEXT,
    inserted     INTEGER,
    error        TEXT
  );
`);

// Single source of truth for collector/UI settings (e.g. GITHUB_EXCLUDE_REPOS).
// Lives in the DB so the remote UI and the local collector share one value.
const getSettingStmt = db.prepare(`SELECT value FROM settings WHERE key = ?`);
const setSettingStmt = db.prepare(
  `INSERT INTO settings (key, value) VALUES (@key, @value)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`
);
export function getSetting(key: string): string {
  const row = getSettingStmt.get(key) as { value: string } | undefined;
  return row?.value ?? "";
}
export function setSetting(key: string, value: string): void {
  setSettingStmt.run({ key, value });
}

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
// node:sqlite has no transaction() helper, so wrap the batch by hand.
export function insertItems(items: ItemInput[]): number {
  const collected_at = new Date().toISOString();
  let inserted = 0;
  db.exec("BEGIN");
  try {
    for (const r of items) {
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
      inserted += Number(res.changes);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return inserted;
}

// All items for a week, newest first — used to build the generation prompt.
const weekItemsStmt = db.prepare(
  `SELECT id, source, title, body, url, occurred_at
     FROM items
    WHERE iso_week = ?
    ORDER BY occurred_at DESC`
);
export function getWeekItems(week: string): Array<{
  id: number;
  source: string;
  title: string | null;
  body: string | null;
  url: string | null;
  occurred_at: string | null;
}> {
  return weekItemsStmt.all(week) as any;
}

const insertDraftStmt = db.prepare(`
  INSERT INTO drafts (created_at, iso_week, input_snapshot, prompt_used, output)
  VALUES (@created_at, @iso_week, @input_snapshot, @prompt_used, @output)
`);
export function saveDraft(d: {
  iso_week: string;
  input_snapshot: string;
  prompt_used: string;
  output: string;
}): number {
  const res = insertDraftStmt.run({ created_at: new Date().toISOString(), ...d });
  return Number(res.lastInsertRowid);
}

const draftsByWeekStmt = db.prepare(
  `SELECT id, created_at, iso_week, output FROM drafts WHERE iso_week = ? ORDER BY created_at DESC`
);
export function getDrafts(week: string): Array<{
  id: number;
  created_at: string;
  iso_week: string;
  output: string;
}> {
  return draftsByWeekStmt.all(week) as any;
}

// --- Collection run queue (UI button + daily timer → local poller) ----------
export interface CollectRun {
  id: number;
  status: "pending" | "running" | "done" | "error";
  source: "manual" | "daily";
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  inserted: number | null;
  error: string | null;
}

// A claimed run that never reports is a dead poller; an unclaimed run means no
// poller is running at all. Reclaim both to 'error' so single-flight can't wedge.
const RUNNING_STALE_MS = 15 * 60_000;
const PENDING_STALE_MS = 30 * 60_000;

const activeRunStmt = db.prepare(
  `SELECT * FROM collect_runs WHERE status IN ('pending','running') ORDER BY id LIMIT 1`
);
const insertRunStmt = db.prepare(
  `INSERT INTO collect_runs (status, source, requested_at) VALUES ('pending', @source, @requested_at)`
);
const getRunStmt = db.prepare(`SELECT * FROM collect_runs WHERE id = ?`);
const latestRunStmt = db.prepare(`SELECT * FROM collect_runs ORDER BY id DESC LIMIT 1`);
const nextPendingStmt = db.prepare(`SELECT * FROM collect_runs WHERE status = 'pending' ORDER BY id LIMIT 1`);
const claimRunStmt = db.prepare(
  `UPDATE collect_runs SET status = 'running', started_at = @started_at
     WHERE id = @id AND status = 'pending'`
);
const finishRunStmt = db.prepare(
  `UPDATE collect_runs SET status = @status, finished_at = @finished_at, inserted = @inserted, error = @error
     WHERE id = @id`
);
const reclaimRunningStmt = db.prepare(
  `UPDATE collect_runs SET status='error', finished_at=@now,
       error='timed out — poller did not report (presumed dead)'
     WHERE status='running' AND started_at < @cut`
);
const reclaimPendingStmt = db.prepare(
  `UPDATE collect_runs SET status='error', finished_at=@now,
       error='timed out — no poller claimed the run'
     WHERE status='pending' AND requested_at < @cut`
);

function reclaimStale(): void {
  const now = Date.now();
  reclaimRunningStmt.run({ now: new Date(now).toISOString(), cut: new Date(now - RUNNING_STALE_MS).toISOString() });
  reclaimPendingStmt.run({ now: new Date(now).toISOString(), cut: new Date(now - PENDING_STALE_MS).toISOString() });
}

// Enqueue a run. Single-flight: if one is already pending/running, return it with
// alreadyActive=true instead of stacking a redundant second pass.
export function enqueueRun(source: "manual" | "daily"): { run: CollectRun; alreadyActive: boolean } {
  reclaimStale();
  const active = activeRunStmt.get() as CollectRun | undefined;
  if (active) return { run: active, alreadyActive: true };
  const res = insertRunStmt.run({ source, requested_at: new Date().toISOString() });
  return { run: getRunStmt.get(Number(res.lastInsertRowid)) as unknown as CollectRun, alreadyActive: false };
}

// Poller claims the oldest pending run (pending → running) atomically.
export function claimNextRun(): CollectRun | null {
  reclaimStale();
  const next = nextPendingStmt.get() as CollectRun | undefined;
  if (!next) return null;
  const res = claimRunStmt.run({ id: next.id, started_at: new Date().toISOString() });
  if (Number(res.changes) === 0) return null; // lost a race; next poll retries
  return getRunStmt.get(next.id) as unknown as CollectRun;
}

// Poller reports the outcome of a claimed run.
export function finishRun(id: number, result: { inserted?: number; error?: string }): void {
  finishRunStmt.run({
    id,
    status: result.error ? "error" : "done",
    finished_at: new Date().toISOString(),
    inserted: result.inserted ?? null,
    error: result.error ?? null,
  });
}

// Latest run (any status) — drives the UI button state + completion notification.
export function latestRun(): CollectRun | null {
  reclaimStale();
  return (latestRunStmt.get() as CollectRun | undefined) ?? null;
}

export default db;
