import fs from "fs";
import path from "path";
import { WORK_DIR } from "./claude-sessions";

// What a crashed run left behind.
//
// A full backlog is ~300 sessions at ~60s each — five hours on one GPU. A power
// cut four hours in used to cost all of it: buildManifest() wiped summaries/ at
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

export interface ProgressEntry {
  mtime: string;
  size: number;
  written_at: string;
}

const progressPath = () => path.join(WORK_DIR, "progress.json");

export function readProgress(): Record<string, ProgressEntry> {
  try {
    return JSON.parse(fs.readFileSync(progressPath(), "utf8")) as Record<string, ProgressEntry>;
  } catch {
    return {};
  }
}

// Write-then-rename: a power cut during the write leaves either the old file or
// the new one, never a half-written ledger. A torn progress.json would be read as
// "{}" by readProgress() above, which is survivable but throws away the whole run's
// resumability — exactly what this module exists to protect.
export function writeProgress(progress: Record<string, ProgressEntry>): void {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const tmp = `${progressPath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(progress, null, 2));
  fs.renameSync(tmp, progressPath());
}
