import fs from "fs";
import path from "path";
import { replaceFileDurable } from "./durable";
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

// Programmatic sessions are not the user's work.
//
// Every transcript records how the session was started. `cli` is a person at a
// terminal; `sdk-py` / `sdk-cli` are a program driving Claude Code — a plugin's
// review fan-out, a script, a scheduled job. Measured on this box: 229 of the 328
// transcripts inside a 14-day window were `sdk-py`, nearly all of them the same
// "Review this change for security vulnerabilities" agent firing once per changed
// file. Summarizing those produces a journal of the tooling rather than of the work,
// and costs about 5.7 hours of GPU time to do it.
//
// Task-tool sub-agents need no handling here: they leave no transcript of their own.
// `isSidechain` exists as a field and is false in all 397 files on this machine, so
// a sub-agent's turns live inside the parent session and are already summarized with
// it, which is what you want.
//
// The test is a DENYLIST on `sdk`, not an allowlist on `cli`, and it fails OPEN: an
// entrypoint this code has never heard of — a future editor or web client — is kept.
// Dropping a real session is silent and unrecoverable; keeping an agent session costs
// one mediocre summary.
const INCLUDE_SDK = process.env.CLAUDE_INCLUDE_SDK_SESSIONS === "1";

// Sessions a hook started in order to reason ABOUT another session.
//
// The claudeception Stop hook writes a slice of the running transcript to /tmp and
// starts a fresh headless `claude -p` on it, so every fire leaves a full transcript
// of its own beside the real one. Those are the tooling talking to itself: the work
// they look at is already in the parent session and summarized there, and an entry
// reading "opened a slice, judged nothing worth capturing" is noise in the journal.
//
// Today those runs record `entrypoint: "sdk-cli"`, so the denylist above already
// drops them — but only incidentally. It holds until a release labels `claude -p`
// something else, and CLAUDE_INCLUDE_SDK_SESSIONS=1 switches it off entirely, which
// is meant to bring agent sessions BACK, never these. So match the child's own
// opening line, which the hook on this box writes and controls.
//
// Matched against the FIRST user message only, never the whole head. A session that
// merely DISCUSSES the hook — editing it, writing a test for this very filter — puts
// that same sentence in its transcript as a tool argument or a file body, and that
// session is real work that belongs in the journal. What a hook child alone has is
// the sentence as the thing it was ASKED, in its opening prompt.
const HOOK_CHILD_MARKERS: RegExp[] = [/Read the file \/tmp\/claude-claudeception-slice-/];

// The opening prompt, i.e. the first user turn carrying plain text. Tool results
// arrive as user records too, with an array content, and are skipped.
function firstPrompt(text: string): string {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      break; // a truncated line means the rest of this buffer is unusable too
    }
    if (o?.type === "user" && typeof o?.message?.content === "string") return o.message.content;
  }
  return "";
}

// The head of a transcript as text. 64 KB: everything classified on sits in the
// first few records, and reading a whole multi-megabyte transcript to decide
// whether to summarize it would cost more than summarizing it.
function head(file: string): string {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return "";
  }
  try {
    const buf = Buffer.alloc(64 * 1024);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    fs.closeSync(fd);
  }
}

export function isProgrammaticSession(file: string): boolean {
  const text = head(file);
  if (!text) return false; // unreadable or empty — keep, per the fail-open rule above
  // Deliberately NOT gated on INCLUDE_SDK: that flag asks for agent sessions back,
  // and a hook summarizing the session already being summarized is never wanted.
  const prompt = firstPrompt(text);
  if (prompt && HOOK_CHILD_MARKERS.some((re) => re.test(prompt))) return true;
  if (INCLUDE_SDK) return false;
  // The field repeats on most records, so the first occurrence is representative.
  const m = text.match(/"entrypoint"\s*:\s*"([^"]+)"/);
  return m ? m[1].startsWith("sdk") : false;
}

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

// The cursor every future run reads. Replaced whole because it IS one value, not
// an accumulation — but flushed, since losing it means re-summarizing work that
// was already imported.
export function writeState(state: State): void {
  replaceFileDurable(statePath(), JSON.stringify(state, null, 2));
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
      if (isProgrammaticSession(full)) continue;
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
  replaceFileDurable(path.join(WORK_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

if (require.main === module) {
  console.log(JSON.stringify(buildManifest(), null, 2));
}
