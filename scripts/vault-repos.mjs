#!/usr/bin/env node
// vault-keeper slice 6 — repo -> Projects backfill + graph freshness.
//
// Ensures every code repo under ~/projects is DOCUMENTED in the Obsidian vault
// and LINKED into the federated graphify graph:
//   1. enumerate git repos under ~/projects
//   2. for each one with no matching Projects/**/<repo>.md note, gather repo
//      facts (README, manifest, remote, recent commits, tree) and have Opus
//      write a Project note in the house style + pick the area folder
//   3. write the note (deterministically, vault-confined) and
//   4. run graphify-bridge.mjs to refresh graph.html + the repos<->Projects canvas
//
// Security model = the inbox sorter's: facts are INLINED into the prompt, the
// model gets NO tools (--disallowed-tools ...), and THIS script does the write,
// confined under the vault. The model proposes; code disposes.
//
//   node scripts/vault-repos.mjs            # backfill missing notes + refresh graph
//   node scripts/vault-repos.mjs --dry      # list repos missing a note; no LLM, no write
//   node scripts/vault-repos.mjs --shadow   # write proposed notes to .vault-keeper/, not the vault
//   node scripts/vault-repos.mjs --repo X   # only repo X (dir under ~/projects)
//   node scripts/vault-repos.mjs --no-bridge# skip the graphify-bridge refresh
//
// Run by the vault-repos systemd --user timer. journalctl --user -t vault-repos

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";

const HOME = os.homedir();
const PROJECTS_ROOT = path.join(HOME, "projects");
const HEADROOM = path.join(HOME, ".local", "bin", "headroom");
const REPO_DIR = path.join(HOME, "projects", "social-update");
const SHADOW_DIR = path.join(REPO_DIR, ".vault-keeper", "repo-shadow");

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const SHADOW = argv.includes("--shadow");
const NO_BRIDGE = argv.includes("--no-bridge");
const FORCE = argv.includes("--force"); // regenerate even if already documented (use with --repo/--shadow)
const ONLY = (() => { const i = argv.indexOf("--repo"); return i >= 0 ? argv[i + 1] : null; })();

// repos that should never get an auto Project note (infra/scratch/etc.)
const SKIP = new Set([]); // (none for now — add repo dir names here to exclude)

// repos already documented under a note whose name does NOT match the repo name
// (keep in sync with OVERRIDES in graphify-bridge.mjs). Treated as documented.
const ALIASES = new Set(["k3s-cluster"]);

const VAULT = execSync(`realpath "${HOME}/obsidian.md"`, { encoding: "utf8" }).trim();
const PROJECTS = path.join(VAULT, "Projects");

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// ---- existing Project notes (normalized basename -> rel path) ----
function listProjectNotes() {
  try {
    return execSync(`cd "${VAULT}" && find Projects -type f -name '*.md'`, { encoding: "utf8" })
      .trim().split("\n").filter(Boolean);
  } catch { return []; }
}
const existing = new Set(listProjectNotes().map((p) => norm(path.basename(p, ".md"))));

// valid area folders = existing top-level dirs under Projects/
const areas = fs.readdirSync(PROJECTS, { withFileTypes: true })
  .filter((d) => d.isDirectory()).map((d) => d.name);

// ---- enumerate repos ----
function listRepos() {
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true }); } catch { return []; }
  return dirs
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(PROJECTS_ROOT, d.name, ".git")))
    .map((d) => d.name)
    .filter((n) => !SKIP.has(n))
    .filter((n) => !ONLY || n === ONLY);
}

const repos = listRepos();
const missing = FORCE
  ? repos
  : repos.filter((r) => !existing.has(norm(r)) && !ALIASES.has(r));

console.log(`repos: ${repos.length}, documented: ${repos.length - missing.length}, missing: ${missing.length}`);
if (missing.length) console.log("missing notes:\n" + missing.map((r) => "  - " + r).join("\n"));

if (DRY) { console.log("\n--dry: no LLM, nothing written."); process.exit(0); }

// ---- gather repo facts (inlined into the prompt; model gets no tools) ----
function facts(repo) {
  const dir = path.join(PROJECTS_ROOT, repo);
  const sh = (cmd) => { try { return execSync(cmd, { cwd: dir, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).trim(); } catch { return ""; } };
  const readHead = (f, n) => { try { return fs.readFileSync(path.join(dir, f), "utf8").slice(0, n); } catch { return ""; } };
  const manifest = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "deno.json"]
    .map((f) => { const c = readHead(f, 2000); return c ? `--- ${f} ---\n${c}` : ""; }).filter(Boolean).join("\n");
  return [
    `remote: ${sh("git remote get-url origin")}`,
    `recent commits:\n${sh("git log --oneline -12")}`,
    `top-level:\n${sh("ls -1")}`,
    `dirs (2 levels):\n${sh("find . -maxdepth 2 -type d -not -path '*/.git/*' -not -path '*/node_modules/*' | head -40")}`,
    manifest ? `manifests:\n${manifest}` : "",
    `README:\n${readHead("README.md", 6000)}`,
  ].filter(Boolean).join("\n\n");
}

// one in-repo note as a style exemplar
const exemplar = (() => {
  for (const rel of ["Projects/Software Engineering/device-activity-telegram-bot.md", "Projects/Trading/invest.md"]) {
    try { return fs.readFileSync(path.join(VAULT, rel), "utf8"); } catch { /* next */ }
  }
  return "";
})();

function buildPrompt(repo) {
  return [
    `You document one developer's code repository as an Obsidian "Project" note.`,
    `Repo directory name: ${repo}`,
    ``,
    `Write a note in EXACTLY the style/sections of this existing note (frontmatter`,
    `with date/tags:[project]/status, "# <name>", then Goal, Stack, Repo, Deploy,`,
    `Status, optional Tasks, Notes (ending with "Area: [[<Area>]]" and any relevant`,
    `[[wikilinks]] to related repos), and a Log with one "Note created from repo`,
    `scan" entry dated ${todayISO()}). Be accurate to the facts; do not invent.`,
    ``,
    `=== STYLE EXEMPLAR (do not copy its content, only its shape) ===`,
    exemplar,
    ``,
    `=== VALID AREA FOLDERS (choose the best fit; or propose a new one under Projects/) ===`,
    areas.join(", "),
    ``,
    `=== REPO FACTS ===`,
    facts(repo),
    ``,
    `Respond with ONLY a JSON object, no prose, no code fences:`,
    `{"area":"<one of the area folders, or a new short area name>","filename":"${repo}.md","markdown":"<the full note markdown>"}`,
  ].join("\n");
}

function todayISO() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Bucharest", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function askOpus(prompt) {
  const raw = execFileSync(
    HEADROOM,
    ["wrap", "claude", "--", "-p", prompt, "--model", "opus", "--permission-mode", "bypassPermissions",
      "--disallowed-tools", "Bash", "Edit", "Write", "NotebookEdit", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Task",
      "--output-format", "json"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, HOME } }
  );
  const envLine = raw.split("\n").reverse().find((l) => l.trim().startsWith('{"type":"result"')) ?? "";
  const result = (() => { try { return JSON.parse(envLine).result ?? ""; } catch { return ""; } })() || raw;
  const jsonText = result.replace(/```json?/gi, "").replace(/```/g, "").replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, "$1");
  return JSON.parse(jsonText);
}

// vault-confined destination
function destRel(area, filename) {
  const safeArea = String(area).replace(/[^A-Za-z0-9 &/+-]/g, "").trim() || "Software Engineering";
  const safeFile = path.basename(String(filename)).replace(/[^A-Za-z0-9 ._-]/g, "").trim();
  if (!safeFile.endsWith(".md")) throw new Error(`bad filename: ${filename}`);
  const rel = path.join("Projects", safeArea, safeFile);
  const abs = path.resolve(VAULT, rel);
  if (abs !== VAULT && !abs.startsWith(VAULT + path.sep)) throw new Error(`refusing to write outside vault: ${rel}`);
  if (!abs.startsWith(path.join(VAULT, "Projects") + path.sep)) throw new Error(`refusing to write outside Projects/: ${rel}`);
  return rel;
}

function writeAtomic(absPath, content) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const tmp = absPath + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, absPath);
}

let created = 0;
for (const repo of missing) {
  try {
    console.log(`\n[${repo}] generating note...`);
    const out = askOpus(buildPrompt(repo));
    if (!out || typeof out.markdown !== "string" || out.markdown.length < 80)
      throw new Error("model returned no usable markdown");
    const rel = destRel(out.area, out.filename || `${repo}.md`);
    if (SHADOW) {
      const sp = path.join(SHADOW_DIR, path.basename(rel));
      writeAtomic(sp, out.markdown);
      console.log(`  [shadow] -> ${sp}  (area: ${out.area})`);
    } else {
      const abs = path.resolve(VAULT, rel);
      if (fs.existsSync(abs)) { console.log(`  exists, skip: ${rel}`); continue; }
      writeAtomic(abs, out.markdown);
      console.log(`  wrote: ${rel}`);
      created++;
    }
  } catch (e) {
    console.log(`  WARN ${repo}: ${e.message}`);
  }
}

console.log(`\n${SHADOW ? "shadow " : ""}done: ${created} note(s) created.`);

// ---- refresh the federated graph views ----
if (!NO_BRIDGE && !SHADOW) {
  try {
    console.log("\nrefreshing graphify bridge...");
    execFileSync("node", [path.join(REPO_DIR, "scripts", "graphify-bridge.mjs")], { stdio: "inherit", env: process.env });
  } catch (e) {
    console.log(`WARN: bridge refresh failed: ${e.message}`);
  }
}
