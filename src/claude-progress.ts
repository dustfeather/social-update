import fs from "fs";
import path from "path";
import { WORK_DIR } from "./claude-sessions";
import { appendLineDurable, replaceFileDurable } from "./durable";

// What a crashed run left behind.
//
// A full backlog is ~130 sessions at ~90s each — hours on one GPU. A power cut
// four hours in used to cost all of it: buildManifest() wiped summaries/ at
// startup, and state.json only advanced at the single end-of-run import, so every
// completed summary was both deleted and un-recorded.
//
// This is the ledger that makes those summaries reusable. It records the exact
// fingerprint of the transcript each summary was written from, which is the part
// that cannot be recovered by looking at the files afterwards: a session that has
// GROWN since its summary was written must be summarized again, and a summary of
// the older, shorter transcript would otherwise be imported as if it covered the
// whole thing — and would advance state to the new fingerprint, so the newer turns
// would never be summarized at all.
//
// It is append-only, one JSON object per line, because the alternative loses more
// than it saves. Serializing the whole ledger per session means the record of 100
// finished sessions is rewritten to record the 101st: N times the writing, and a
// crash mid-write puts every one of them in the same file. Appending touches only
// the bytes being added, so the worst a crash can cost is the line it was writing —
// and readProgress() below drops exactly that one line and keeps the other 100.
// Later lines win over earlier ones for the same session, which is also how an
// entry is removed: a tombstone line rather than a rewrite without it.

export interface ProgressEntry {
  mtime: string;
  size: number;
  written_at: string;
}

const ledgerPath = () => path.join(WORK_DIR, "progress.jsonl");
// The pre-JSONL ledger. Read once so an interrupted run from before this change
// still resumes; never written again.
const legacyPath = () => path.join(WORK_DIR, "progress.json");

export function readProgress(): Record<string, ProgressEntry> {
  let text: string;
  try {
    text = fs.readFileSync(ledgerPath(), "utf8");
  } catch {
    return readLegacyProgress();
  }

  const progress: Record<string, ProgressEntry> = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec: Partial<ProgressEntry> & { session_id?: string; forgotten?: boolean };
    try {
      rec = JSON.parse(line);
    } catch {
      // A line torn by a crash — in practice only ever the last one. Skipping it
      // costs one session's resumability; refusing to read the file would cost
      // every session's.
      continue;
    }
    if (!rec || typeof rec.session_id !== "string") continue;
    if (rec.forgotten) {
      delete progress[rec.session_id];
    } else if (typeof rec.mtime === "string" && typeof rec.size === "number") {
      progress[rec.session_id] = {
        mtime: rec.mtime,
        size: rec.size,
        written_at: rec.written_at ?? "",
      };
    }
  }
  return progress;
}

function readLegacyProgress(): Record<string, ProgressEntry> {
  try {
    return JSON.parse(fs.readFileSync(legacyPath(), "utf8")) as Record<string, ProgressEntry>;
  } catch {
    return {};
  }
}

// One session finished. Appended and flushed before the loop moves on, so the
// summary just written is reusable from the moment it exists.
export function recordProgress(sessionId: string, entry: ProgressEntry): void {
  appendLineDurable(ledgerPath(), JSON.stringify({ session_id: sessionId, ...entry }));
}

// This session's summary has been imported (or its file is gone), so the ledger
// must stop promising it. A tombstone rather than a rewrite: same reasoning as
// above, and it keeps every write in this module O(1).
export function forgetProgress(sessionId: string): void {
  appendLineDurable(ledgerPath(), JSON.stringify({ session_id: sessionId, forgotten: true }));
}

// Collapse the ledger to one line per live session. Append-only files grow without
// bound, so this runs once per run at startup — where the caller has just read the
// whole ledger and pruned it, i.e. the one moment the in-memory map is known to be
// complete. Calling it anywhere else would write the same O(n) file this module
// exists to avoid, and would race any append that follows.
export function compactProgress(progress: Record<string, ProgressEntry>): void {
  const lines = Object.entries(progress).map(([session_id, e]) =>
    JSON.stringify({ session_id, ...e })
  );
  replaceFileDurable(ledgerPath(), lines.length ? `${lines.join("\n")}\n` : "");
  fs.rmSync(legacyPath(), { force: true });
}
