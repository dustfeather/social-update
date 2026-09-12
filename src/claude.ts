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
        // A permission prompt in print mode is an instant denial, so the run has
        // to be pre-authorized. What it is authorized for is deliberately narrow.
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
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        [
          "Task",
          "Agent",
          "Read",
          "Write",
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

export async function collectClaude(): Promise<number> {
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
