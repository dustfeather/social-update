// vault-keeper slice 3 — daily writer (VAULT-KEEPER.md §4.2, §5).
//
// Reads LOCAL signals for a day — git activity across ~/projects/* repos and the
// day's Claude Code transcripts — asks Opus to distill them into a structured
// plan (no tools; read-only), then applies the plan DETERMINISTICALLY:
//   - daily digest into Daily Notes/YYYY/MM/DD (ddd).md inside a managed block
//     (idempotent by date — re-running replaces the block, never duplicates),
//   - per-project activity + decision-log entries appended with ledger dedup
//     (decisions keyed by sessionId:index, so reruns never re-append),
//   - Local Repos map auto-extended for unmapped active repos, disclosed in the
//     day's note.
// All vault writes are atomic (temp file + rename). Safety comes from
// deterministic application confined to the vault, not from trusting the model.
//
//   node dist/vault-daily.js              # apply for today
//   node dist/vault-daily.js --shadow     # compute + dump proposed output, write nothing
//   node dist/vault-daily.js 2026-06-25   # apply for a specific date
//
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { DatabaseSync } from "node:sqlite";
import { config } from "dotenv";
import { expandHome } from "./paths";

config();

const VAULT = expandHome(process.env.VAULT_PATH ?? "~/obsidian.md");
const PROJECTS_ROOT = path.join(os.homedir(), "projects");
const CLAUDE_PROJECTS = expandHome(process.env.CLAUDE_PROJECTS ?? "~/.claude/projects");
const LEDGER_DIR = path.join(__dirname, "..", ".vault-keeper");
const LEDGER_PATH = path.join(LEDGER_DIR, "ledger.sqlite");
const LOCAL_REPOS_NOTE = "Resources/Engineering/Local Repos.md";
const HEADROOM = path.join(os.homedir(), ".local", "bin", "headroom");
const TZ = "Europe/Bucharest";

const DIGEST_START = "<!-- vault-keeper:digest:start -->";
const DIGEST_END = "<!-- vault-keeper:digest:end -->";

// repos that are infra, not worth their own project note / digest mention
const SKIP_REPOS = new Set(["social-update", "obsidian-sync", "dustfeather"]);

const SHADOW = process.argv.includes("--shadow");
const dateArg = process.argv.slice(2).find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));

// ---- date helpers (Bucharest) ---------------------------------------------
function parts(d: Date) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(d);
  const g = (t: string) => f.find((p) => p.type === t)!.value;
  return { y: g("year"), m: g("month"), d: g("day"), ddd: g("weekday") };
}
const today = dateArg ? new Date(dateArg + "T12:00:00") : new Date();
const P = parts(today);
const DATE = `${P.y}-${P.m}-${P.d}`;                       // YYYY-MM-DD
const DAILY_REL = `Daily Notes/${P.y}/${P.m}/${P.d} (${P.ddd}).md`;

// ---- ledger ----------------------------------------------------------------
fs.mkdirSync(LEDGER_DIR, { recursive: true });
const led = new DatabaseSync(LEDGER_PATH);
led.exec(`
  CREATE TABLE IF NOT EXISTS vault_writes (
    key TEXT PRIMARY KEY, kind TEXT, target TEXT, date TEXT, written_at TEXT
  );
  CREATE TABLE IF NOT EXISTS repo_map (
    folder TEXT PRIMARY KEY, vault_note TEXT, github_slug TEXT,
    auto INTEGER DEFAULT 0, added_at TEXT
  );
`);
const seen = (key: string) =>
  !!led.prepare("SELECT 1 FROM vault_writes WHERE key = ?").get(key);
const record = (key: string, kind: string, target: string) =>
  led.prepare(
    "INSERT OR IGNORE INTO vault_writes (key,kind,target,date,written_at) VALUES (?,?,?,?,?)"
  ).run(key, kind, target, DATE, new Date().toISOString());

// ---- atomic vault write ----------------------------------------------------
function absInVault(rel: string): string {
  const abs = path.resolve(VAULT, rel);
  if (abs !== VAULT && !abs.startsWith(VAULT + path.sep))
    throw new Error(`refusing write outside vault: ${rel}`);
  return abs;
}
function writeAtomic(rel: string, content: string) {
  const abs = absInVault(rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = abs + ".vk-tmp-" + crypto.randomBytes(4).toString("hex");
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, abs);
}
function readVault(rel: string): string {
  try { return fs.readFileSync(absInVault(rel), "utf8"); } catch { return ""; }
}

// ---- signal gathering ------------------------------------------------------
interface Commit { hash: string; subject: string; stat: string; }
interface RepoActivity { folder: string; commits: Commit[]; prompts: string[]; }

function git(dir: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch { return ""; }
}

function gitActivity(): Map<string, Commit[]> {
  const out = new Map<string, Commit[]>();
  let dirs: fs.Dirent[];
  try { dirs = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true }); } catch { return out; }
  for (const e of dirs) {
    if (!e.isDirectory() || SKIP_REPOS.has(e.name)) continue;
    const dir = path.join(PROJECTS_ROOT, e.name);
    if (!fs.existsSync(path.join(dir, ".git"))) continue;
    // %x1f = unit separator between fields, %x1e = record separator between commits
    const log = git(dir, [
      "log", "--all", `--since=${DATE} 00:00:00`, `--until=${DATE} 23:59:59`,
      "--pretty=format:%h\x1f%s\x1e", "--shortstat",
    ]);
    if (!log.trim()) continue;
    const commits: Commit[] = [];
    for (const rec of log.split("\x1e")) {
      const [head, ...rest] = rec.split("\n");
      if (!head.includes("\x1f")) continue;
      const [hash, subject] = head.split("\x1f");
      const stat = rest.join(" ").trim();
      if (hash) commits.push({ hash: hash.trim(), subject: (subject ?? "").trim(), stat });
    }
    if (commits.length) out.set(e.name, commits);
  }
  return out;
}

// the day's user prompts from transcripts whose encoded dir maps to <folder>
function transcriptPrompts(folder: string): string[] {
  const prompts: string[] = [];
  let dirs: fs.Dirent[];
  try { dirs = fs.readdirSync(CLAUDE_PROJECTS, { withFileTypes: true }); } catch { return prompts; }
  const needle = `-projects-${folder.replace(/[^a-zA-Z0-9]/g, "-")}`;
  for (const e of dirs) {
    if (!e.isDirectory() || !e.name.includes(needle)) continue;
    const tdir = path.join(CLAUDE_PROJECTS, e.name);
    let files: string[];
    try { files = fs.readdirSync(tdir).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      const sid = f.replace(/\.jsonl$/, "");
      let lines: string[];
      try { lines = fs.readFileSync(path.join(tdir, f), "utf8").split("\n"); } catch { continue; }
      let idx = 0;
      for (const ln of lines) {
        if (!ln.trim() || !ln.includes(DATE)) continue;
        let o: any;
        try { o = JSON.parse(ln); } catch { continue; }
        if (typeof o?.timestamp !== "string" || !o.timestamp.startsWith(DATE)) continue;
        if (o?.type !== "user" || o?.message?.role !== "user") continue;
        const c = o.message.content;
        const text = typeof c === "string"
          ? c
          : Array.isArray(c) ? c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join(" ") : "";
        const clean = text.replace(/\s+/g, " ").trim();
        if (clean.length < 12 || clean.startsWith("<")) continue; // skip tool-result/hook noise
        prompts.push(`[${sid.slice(0, 8)}#${idx}] ${clean.slice(0, 400)}`);
        idx++;
        if (prompts.length >= 40) return prompts;
      }
    }
  }
  return prompts;
}

// ---- Local Repos map -------------------------------------------------------
// table columns: | Local folder | GitHub slug | Vault note ([[...]]) |
function loadRepoMap(): Map<string, { note: string; slug: string }> {
  const map = new Map<string, { note: string; slug: string }>();
  for (const row of readVault(LOCAL_REPOS_NOTE).split("\n")) {
    const m = row.match(/^\s*\|(.+)\|\s*$/);
    if (!m) continue;
    const cells = m[1].split("|").map((c) => c.trim());
    if (cells.length < 3) continue;
    const link = cells[2].match(/\[\[([^\]|]+)/);
    if (!link) continue; // header / separator / non-mapping row → no [[note]]
    const folder = cells[0].replace(/`/g, "").trim();
    if (!folder) continue;
    map.set(folder, { note: link[1].trim(), slug: cells[1].replace(/[`*()]/g, "").trim() });
  }
  // overlay anything we auto-added previously
  for (const r of led.prepare("SELECT folder, vault_note, github_slug FROM repo_map").all() as any[])
    if (!map.has(r.folder)) map.set(r.folder, { note: r.vault_note, slug: r.github_slug ?? "" });
  return map;
}
function titleCase(s: string): string {
  return s.replace(/.*\//, "").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// vault notes are filename-based wikilinks (e.g. [[itguys.ro]]); resolve a note
// name/path to the EXISTING file's vault-relative path, else a Projects/ default.
let basenameIndex: Map<string, string> | null = null;
function buildIndex(): Map<string, string> {
  const idx = new Map<string, string>();
  const skip = new Set([".obsidian", ".trash", ".git", "node_modules", ".stfolder"]);
  const walk = (dir: string) => {
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(path.join(dir, e.name)); }
      else if (e.name.toLowerCase().endsWith(".md")) {
        const rel = path.relative(VAULT, path.join(dir, e.name));
        const base = e.name.replace(/\.md$/i, "");
        if (!idx.has(base)) idx.set(base, rel); // first match wins
      }
    }
  };
  walk(VAULT);
  return idx;
}
function resolveNoteRel(note: string): string {
  const name = note.replace(/^\[\[|\]\]$/g, "").replace(/\.md$/i, "").trim();
  if (name.includes("/")) {
    const rel = name + ".md";
    if (fs.existsSync(path.join(VAULT, rel))) return rel;
    return /^(Projects|Resources|Notes)\//.test(rel) ? rel : `Projects/${name}.md`;
  }
  basenameIndex ??= buildIndex();
  return basenameIndex.get(name) ?? `Projects/${name}.md`;
}

// ---- Opus structured distillation -----------------------------------------
interface Plan {
  digest: string;
  projects: Array<{ folder: string; note: string; activity: string; decisions: Array<{ id: string; text: string }> }>;
}
function distill(repos: RepoActivity[], mapHint: Record<string, string>): Plan {
  let prompt = `You distill one developer's day into vault content. Date: ${DATE}.\n`;
  prompt += `Below is per-repo git activity and the day's Claude Code prompts. Produce a JSON object ONLY (no prose, no fences):\n`;
  prompt += `{"digest":"<markdown: 3-8 terse bullet lines summarizing the day across all repos>",`;
  prompt += `"projects":[{"folder":"<repo>","note":"<vault note path>","activity":"<1-3 md lines: what changed & why>",`;
  prompt += `"decisions":[{"id":"<the [sid#n] tag of the prompt that drove it>","text":"<one-line decision actually made>"}]}]}\n`;
  prompt += `Rules: only include a decision if a real, consequential choice was made (architecture, tradeoff, scope). Empty array if none. Never invent. Use the provided note path per folder.\n\n`;
  for (const r of repos) {
    prompt += `=== REPO: ${r.folder}  (note: ${mapHint[r.folder] ?? "?"}) ===\n`;
    prompt += `commits:\n` + r.commits.map((c) => `  ${c.hash} ${c.subject}${c.stat ? "  (" + c.stat + ")" : ""}`).join("\n") + "\n";
    if (r.prompts.length) prompt += `prompts:\n` + r.prompts.map((p) => "  " + p).join("\n") + "\n";
    prompt += "\n";
  }

  const raw = execFileSync(
    HEADROOM,
    ["wrap", "claude", "--", "-p", prompt, "--model", "opus", "--permission-mode", "bypassPermissions",
     "--disallowed-tools", "Bash", "Edit", "Write", "NotebookEdit", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Task",
     "--output-format", "json"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, HOME: os.homedir() } }
  );
  const envLine = raw.split("\n").reverse().find((l) => l.trim().startsWith('{"type":"result"')) ?? "";
  const result = (() => { try { return JSON.parse(envLine).result ?? ""; } catch { return ""; } })();
  const jsonText = result.replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, "$1");
  const plan = JSON.parse(jsonText) as Plan;
  if (!plan || typeof plan.digest !== "string" || !Array.isArray(plan.projects))
    throw new Error("distill: model did not return a valid plan");
  return plan;
}

// ---- managed-block daily note ---------------------------------------------
function upsertDigest(plan: Plan, disclosures: string[]) {
  const touched = plan.projects.map((p) => `- [[${p.note}]]`).join("\n");
  const block =
    `${DIGEST_START}\n## Daily digest\n${plan.digest.trim()}\n\n` +
    (touched ? `**Projects touched:**\n${touched}\n` : "") +
    (disclosures.length ? `\n${disclosures.join("\n")}\n` : "") +
    `${DIGEST_END}`;

  let body = readVault(DAILY_REL);
  if (!body) body = `# ${P.d} (${P.ddd})\n\n`;
  if (body.includes(DIGEST_START) && body.includes(DIGEST_END)) {
    body = body.replace(new RegExp(escapeRe(DIGEST_START) + "[\\s\\S]*?" + escapeRe(DIGEST_END)), block);
  } else {
    body = body.replace(/\s*$/, "\n\n") + block + "\n";
  }
  if (SHADOW) shadowDump(DAILY_REL, body);
  else { writeAtomic(DAILY_REL, body); record(`digest:${DATE}`, "digest", DAILY_REL); }
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---- per-project activity + decision log ----------------------------------
function upsertProject(p: Plan["projects"][number]) {
  const rel = resolveNoteRel(p.note);
  let body = readVault(rel);
  let created = false;
  if (!body) { body = `# ${titleCase(p.folder)}\n`; created = true; }
  let changed = created;

  // Activity log: one dated entry per day (ledger-deduped)
  const actKey = `project:${p.folder}:${DATE}`;
  if (p.activity?.trim() && !seen(actKey)) {
    if (!/^##\s+Activity Log/m.test(body)) body = body.replace(/\s*$/, "\n\n") + "## Activity Log\n";
    const entry = `\n### ${DATE}\n${p.activity.trim()}\n`;
    body = body.replace(/(##\s+Activity Log\n)/, `$1${entry}`);
    changed = true;
  }

  // Decision log: dedup per-note (a decision may legitimately land in two repo
  // notes in one run; key includes rel so reruns skip but cross-note doesn't).
  const fresh = (p.decisions ?? []).filter((d) => d.id && d.text && !seen(`decision:${rel}:${d.id}`));
  if (fresh.length) {
    if (!/^##\s+Decisions/m.test(body)) body = body.replace(/\s*$/, "\n\n") + "## Decisions\n";
    const lines = fresh.map((d) => `- ${DATE} — ${d.text.trim()}  <!-- ${d.id} -->`).join("\n");
    body = body.replace(/(##\s+Decisions\n)/, `$1${lines}\n`);
    changed = true;
  }

  if (!changed) return;
  if (SHADOW) { shadowDump(rel, body); return; }
  writeAtomic(rel, body);
  if (p.activity?.trim()) record(actKey, "project", rel);
  for (const d of fresh) record(`decision:${rel}:${d.id}`, "decision", rel);
}

// ---- shadow output ---------------------------------------------------------
const shadowLog: string[] = [];
function shadowDump(rel: string, body: string) {
  shadowLog.push(`\n========== ${rel} ==========\n${body}`);
}

// ---- main ------------------------------------------------------------------
function main() {
  const gitMap = gitActivity();
  const repoMap = loadRepoMap();

  // active folders = git activity ∪ (transcript-only is noise without commits; require commits)
  const repos: RepoActivity[] = [];
  const disclosures: string[] = [];
  const newAuto: Array<[string, string, string]> = [];
  for (const [folder, commits] of gitMap) {
    let mapped = repoMap.get(folder);
    if (!mapped) {
      const guess = `Projects/${titleCase(folder)}`;
      mapped = { note: guess, slug: "" };
      repoMap.set(folder, mapped);
      newAuto.push([folder, guess, ""]);
      disclosures.push(`> 🆕 mapped repo \`${folder}\` → [[${guess}]] — correct if wrong`);
    }
    repos.push({ folder, commits, prompts: transcriptPrompts(folder) });
  }

  if (!repos.length) { console.log(`vault-daily ${DATE}: no local repo activity; nothing to write`); return; }
  console.log(`vault-daily ${DATE}: ${repos.length} active repo(s)${SHADOW ? " (SHADOW)" : ""}`);

  const mapHint: Record<string, string> = {};
  for (const r of repos) mapHint[r.folder] = repoMap.get(r.folder)!.note;

  const plan = distill(repos, mapHint);

  // persist auto-map rows (ledger + Local Repos note), unless shadow
  if (!SHADOW) {
    for (const [folder, note, slug] of newAuto)
      led.prepare("INSERT OR IGNORE INTO repo_map (folder,vault_note,github_slug,auto,added_at) VALUES (?,?,?,1,?)")
        .run(folder, note, slug, new Date().toISOString());
    if (newAuto.length) appendLocalReposRows(newAuto);
  }

  upsertDigest(plan, disclosures);
  for (const p of plan.projects) upsertProject(p);

  if (SHADOW) {
    const out = path.join(LEDGER_DIR, `shadow-${DATE}.md`);
    fs.writeFileSync(out, shadowLog.join("\n") || "(no changes)");
    console.log(`SHADOW: proposed output written to ${out} (vault untouched)`);
  } else {
    console.log(`done: digest + ${plan.projects.length} project note(s) updated`);
  }
}

function appendLocalReposRows(rows: Array<[string, string, string]>) {
  let body = readVault(LOCAL_REPOS_NOTE);
  if (!body) body = `# Local Repos\n\n| Folder | Vault note | GitHub slug |\n| --- | --- | --- |\n`;
  const add = rows.map(([f, n, s]) => `| \`${f}\` | [[${n}]] | ${s} |`).join("\n");
  body = body.replace(/\s*$/, "\n") + add + "\n";
  writeAtomic(LOCAL_REPOS_NOTE, body);
}

main();
