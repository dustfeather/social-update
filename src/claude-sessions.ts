import fs from "fs";
import path from "path";
import os from "os";
import { config } from "dotenv";
import { expandHome } from "./paths";

config({ quiet: true });

export const CLAUDE_PROJECTS = expandHome(process.env.CLAUDE_PROJECTS ?? "~/.claude/projects");

// Where the manifest, the per-session summaries and the state file live. Outside
// the repo on purpose: this is a cache, and a half-finished run should never show
// up in `git status`.
export const WORK_DIR = expandHome(
  process.env.CLAUDE_WORK_DIR ?? path.join(os.homedir(), ".cache", "social-update", "claude")
);

// Sessions older than this are never summarized. The ONLY brake on fan-out: a
// first run with an empty state file would otherwise spawn one sub-agent per
// session file ever written.
const LOOKBACK_DAYS = Number(process.env.CLAUDE_LOOKBACK_DAYS ?? 14);

export interface SessionRef {
  session_id: string;
  project: string;
  path: string;
  mtime: string;
  size: number;
}

// session_id -> the file fingerprint we last IMPORTED. Advanced by claude-import
// after a successful insert, never by this scanner: a run that dies between
// summarizing and importing must re-summarize, not silently skip.
type State = Record<string, { mtime: string; size: number }>;

const statePath = () => path.join(WORK_DIR, "state.json");

export function readState(): State {
  try {
    return JSON.parse(fs.readFileSync(statePath(), "utf8")) as State;
  } catch {
    return {};
  }
}

export function writeState(state: State): void {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
}

// The cwd recorded on session entries is the honest project name; the directory
// name is a lossy encoding of it (slashes become dashes, so it cannot be decoded
// back reliably). Read the first line that carries one, fall back to the dir.
function projectOf(file: string, dirName: string): string {
  let head = "";
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    head = buf.subarray(0, n).toString("utf8");
  } catch {
    return path.basename(dirName.replace(/^-/, "/").replace(/-/g, "/"));
  }
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (typeof o?.cwd === "string" && o.cwd) return path.basename(o.cwd);
    } catch {
      break; // a truncated first line means the rest of this buffer is unusable too
    }
  }
  return path.basename(dirName.replace(/^-/, "/").replace(/-/g, "/"));
}

// Sessions worth summarizing this run: inside the lookback window, and either
// never imported or grown since the last import.
export function pendingSessions(): SessionRef[] {
  const state = readState();
  const cutoff = Date.now() - LOOKBACK_DAYS * 86_400_000;
  const out: SessionRef[] = [];

  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(CLAUDE_PROJECTS, { withFileTypes: true });
  } catch {
    return out; // no projects dir — nothing to collect
  }

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const dirPath = path.join(CLAUDE_PROJECTS, dir.name);
    let files: string[];
    try {
      files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      const full = path.join(dirPath, file);
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.mtimeMs < cutoff) continue;
      if (st.size === 0) continue;
      const session_id = path.basename(file, ".jsonl");
      const mtime = new Date(st.mtimeMs).toISOString();
      const seen = state[session_id];
      // Size, not just mtime: a session that was merely re-opened touches mtime
      // without gaining content, and re-summarizing it buys nothing.
      if (seen && seen.mtime === mtime && seen.size === st.size) continue;
      out.push({ session_id, project: projectOf(full, dir.name), path: full, mtime, size: st.size });
    }
  }
  // Oldest first so a backlog drains in chronological order.
  return out.sort((a, b) => a.mtime.localeCompare(b.mtime));
}

export interface Manifest {
  generated_at: string;
  work_dir: string;
  summary_dir: string;
  sessions: SessionRef[];
}

// Lay out the run directory and describe the work.
//
// The summary dir is NOT wiped. It used to be, because a leftover summary from a
// previous run would be imported as if it were produced now and would advance its
// session's state entry with it. That protection now lives in the resume check in
// claude.ts, which reuses a leftover only when the ledger (claude-progress.ts) says
// it was written from the transcript exactly as it stands today — and prunes it
// otherwise. Wiping here instead would throw away every summary a five-hour run
// completed before it was interrupted, which is the thing that made a power cut
// cost the whole backlog.
export function buildManifest(): Manifest {
  const summary_dir = path.join(WORK_DIR, "summaries");
  fs.mkdirSync(summary_dir, { recursive: true });
  const manifest: Manifest = {
    generated_at: new Date().toISOString(),
    work_dir: WORK_DIR,
    summary_dir,
    sessions: pendingSessions(),
  };
  fs.writeFileSync(path.join(WORK_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

if (require.main === module) {
  console.log(JSON.stringify(buildManifest(), null, 2));
}
