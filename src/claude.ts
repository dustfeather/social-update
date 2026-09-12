import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { config } from "dotenv";
import { buildManifest, WORK_DIR } from "./claude-sessions";
import { importSummaries } from "./claude-import";
import { SCHEMA_DOC } from "./summary";

config({ quiet: true });

// Collection is an agent run, not a parser. The old collector took each session's
// first prompt as the item — the question, never the answer. Here one orchestrating
// agent fans out a sub-agent per session, each reads the whole transcript and
// writes a validated summary, and the orchestrator imports them and assigns tags
// across the batch. See prompts/collect-agent.md for what it is told to do.

const REPO = path.join(__dirname, "..");
const PROMPT_PATH = path.join(REPO, "prompts", "collect-agent.md");

// The agent may legitimately run for a long time — a wide fan-out over big
// transcripts is minutes, not seconds. It must not run forever, though: a wedged
// run would hold the collector's slot until the next timer fires.
const TIMEOUT_MS = Number(process.env.CLAUDE_AGENT_TIMEOUT_MIN ?? 45) * 60_000;

// Indent a block so it sits inside the prompt's sub-agent instructions.
const indent = (s: string, by = "    ") => s.split("\n").map((l) => by + l).join("\n");

export function buildPrompt(count: number): string {
  return fs
    .readFileSync(PROMPT_PATH, "utf8")
    .replaceAll("{{REPO}}", REPO)
    .replaceAll("{{MANIFEST}}", path.join(WORK_DIR, "manifest.json"))
    .replaceAll("{{SUMMARY_DIR}}", path.join(WORK_DIR, "summaries"))
    .replaceAll("{{WORK_DIR}}", WORK_DIR)
    .replaceAll("{{COUNT}}", String(count))
    .replaceAll("{{SCHEMA}}", indent(SCHEMA_DOC));
}

function runAgent(prompt: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "claude",
      [
        "-p",
        // WORK_DIR lives outside the repo, and `cwd` below is the only directory
        // the agent may write to by default — an allowedTools `Write(...)` rule
        // grants a tool, not a sandbox root, so without this every sub-agent's
        // write to the summary directory is refused with "may only create
        // directories in the allowed working directories for this session".
        "--add-dir",
        WORK_DIR,
        // No --permission-mode: the default leaves the allowlist below as the only
        // thing that grants anything, which is the point. `acceptEdits` auto-approves
        // every Write and Edit REGARDLESS of the allowlist, so with it set the path
        // scope on Write is decorative — an earlier run of this collector edited
        // src/claude.ts while nominally confined to the scratch directory. In print
        // mode a non-allowlisted tool cannot prompt, so it is simply refused.
        //
        // What the run is authorized for is deliberately narrow.
        //
        // The sub-agents read session transcripts, and a transcript contains
        // whatever text ever passed through a session — pasted pages, repo files,
        // error output. That is untrusted input, so this allowlist is the boundary
        // that keeps a prompt injection inside it from becoming code execution:
        //
        //   - `node` is pinned to the three scripts of this pipeline by full path.
        //     A bare `Bash(node:*)` would permit `node -e "..."`, which is simply
        //     "run anything" spelled differently.
        //   - the reading tools (wc/grep/head/tail) cannot execute, and the agents
        //     already have Read.
        //   - no WebFetch/WebSearch: without an outbound channel, anything that did
        //     get through has nowhere to send what it found.
        "--allowedTools",
        [
          "Task",
          "Agent",
          "Read",
          // Write is scoped to the run's scratch directory. The agents have no
          // business editing this repository, and an unattended run that edits
          // source is a surprise waiting to be committed by whoever runs
          // `git add -A` next.
          `Write(${WORK_DIR}/**)`,
          "Glob",
          "Grep",
          `Bash(node ${REPO}/dist/summary-validate.js:*)`,
          `Bash(node ${REPO}/dist/claude-import.js:*)`,
          `Bash(node ${REPO}/dist/claude-tag.js:*)`,
          "Bash(wc:*)",
          "Bash(grep:*)",
          "Bash(head:*)",
          "Bash(tail:*)",
        ].join(","),
        "--disallowedTools",
        "WebFetch,WebSearch",
      ],
      { cwd: REPO, stdio: ["pipe", "pipe", "pipe"] }
    );

    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`agent exceeded ${TIMEOUT_MS / 60_000} min — killed`));
    }, TIMEOUT_MS);

    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // The agent's own words go to the collector log: this is the only place the
      // run explains itself, and a silent success is indistinguishable from a
      // silent no-op when something later looks wrong.
      if (out.trim()) console.log(indent(out.trim(), "  | "));
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.trim().slice(0, 500)}`));
      resolve();
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// Two collectors in the same WORK_DIR destroy each other: buildManifest() wipes
// summaries/ before it writes, so a run starting at 18:00 deletes the completed
// summaries of a run that started at 17:29, and both then fan out writing over
// one manifest and one state file. It happens on its own — the systemd timer
// fires on a schedule and a manual backfill is exactly the kind of long run it
// lands in the middle of. The DB's enqueueRun() single-flight does not help:
// that guards POST /api/collect, and both the timer and a manual run invoke
// `node dist/collect.js` directly, which never touches it.
//
// "wx" is the whole mechanism — create-exclusive is atomic, so the loser of a
// race gets EEXIST rather than a torn read of somebody's pid.
const LOCK_PATH = path.join(WORK_DIR, "collect.lock");

export function acquireLock(): boolean {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  try {
    fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), {
      flag: "wx",
    });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }

  // A lock is present. A killed run leaves one behind, so a stale lock must not
  // wedge collection forever: if nothing is alive on that pid, take it over.
  let holder: { pid?: number; started?: string } = {};
  try {
    holder = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
  } catch {
    // Unreadable lock — treat as stale rather than blocking on garbage.
  }
  const alive = (() => {
    if (!holder.pid) return false;
    try {
      process.kill(holder.pid, 0); // signal 0 tests existence, sends nothing
      return true;
    } catch {
      return false;
    }
  })();

  if (alive) {
    console.log(
      `[collect] claude: another collection is running (pid ${holder.pid}, started ${holder.started}) — skipping`
    );
    return false;
  }

  console.warn(`[collect] claude: clearing a stale lock from pid ${holder.pid ?? "?"}`);
  fs.rmSync(LOCK_PATH, { force: true });
  fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), {
    flag: "wx",
  });
  return true;
}

export async function collectClaude(): Promise<number> {
  if (!acquireLock()) return 0;
  try {
    return await collectClaudeLocked();
  } finally {
    fs.rmSync(LOCK_PATH, { force: true });
  }
}

async function collectClaudeLocked(): Promise<number> {
  const manifest = buildManifest();
  const count = manifest.sessions.length;
  if (count === 0) {
    console.log("[collect] claude: no new or changed sessions since the last run");
    return 0;
  }
  console.log(`[collect] claude: ${count} session(s) to summarize`);

  try {
    await runAgent(buildPrompt(count));
  } catch (err) {
    // A killed or crashed agent may still have left good summaries behind.
    // Salvage them rather than throwing the whole run away — the sessions it
    // never reached keep their state entry and come back next time.
    console.error(`[collect] claude: ${err instanceof Error ? err.message : err}`);
    console.error("[collect] claude: importing whatever summaries landed");
    const salvaged = await importSummaries();
    console.log(`[collect] claude: salvaged ${salvaged.written} item(s)`);
    return salvaged.written;
  }

  // The agent runs the import itself; read its report rather than trusting the
  // final message, which is prose.
  const reportPath = path.join(WORK_DIR, "import-report.json");
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as { written?: number };
    return Number(report.written ?? 0);
  } catch {
    throw new Error(`agent finished but wrote no import report at ${reportPath}`);
  }
}
