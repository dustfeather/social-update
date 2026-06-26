// vault-keeper slice 5 — weekly LinkedIn drafts (VAULT-KEEPER.md §4.3).
//
// Runs Sunday evening, after the daily writer. Gathers the ISO week's already-
// distilled signal — the seven daily digest blocks slice 3 wrote, a git oneline
// backup across ~/projects/* for the week, and any items the author hand-curated
// in the weekly note's manual block — then asks Opus (reusing prompt.txt as the
// instruction, no tools / read-only) to produce 2-4 copy-ready LinkedIn drafts.
//
// Output lands in a weekly note Daily Notes/YYYY/Www.md inside a managed block
// (idempotent by ISO week — re-running replaces the drafts block, never
// duplicates). The author's manual block is preserved verbatim across reruns.
// All vault writes are atomic (temp file + rename); safety comes from
// deterministic application confined to the vault, not from trusting the model.
//
//   node dist/vault-weekly.js              # drafts for the current ISO week
//   node dist/vault-weekly.js --shadow     # compute + dump proposed output, write nothing
//   node dist/vault-weekly.js 2026-06-22   # drafts for the ISO week containing that date
//
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { config } from "dotenv";
import { expandHome } from "./paths";

config();

const VAULT = expandHome(process.env.VAULT_PATH ?? "~/obsidian.md");
const PROJECTS_ROOT = path.join(os.homedir(), "projects");
const PROMPT_TXT = path.join(__dirname, "..", "prompt.txt");
const HEADROOM = path.join(os.homedir(), ".local", "bin", "headroom");
const TZ = "Europe/Bucharest";

// reuse slice 3's digest markers — we read the blocks it wrote per day
const DIGEST_START = "<!-- vault-keeper:digest:start -->";
const DIGEST_END = "<!-- vault-keeper:digest:end -->";
// our own managed blocks in the weekly note
const DRAFTS_START = "<!-- vault-keeper:drafts:start -->";
const DRAFTS_END = "<!-- vault-keeper:drafts:end -->";
const MANUAL_START = "<!-- vault-keeper:manual:start -->";
const MANUAL_END = "<!-- vault-keeper:manual:end -->";
const MANUAL_HINT = "<!-- Add your own items below, one per line. Preserved across regeneration. -->";

// infra repos — not worth surfacing in a LinkedIn draft (mirrors the daily writer)
const SKIP_REPOS = new Set(["social-update", "obsidian-sync", "dustfeather"]);

const SHADOW = process.argv.includes("--shadow");
const dateArg = process.argv.slice(2).find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));

// ---- date / ISO-week helpers (Bucharest calendar) -------------------------
function parts(d: Date) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(d);
  const g = (t: string) => f.find((p) => p.type === t)!.value;
  return { y: g("year"), m: g("month"), d: g("day"), ddd: g("weekday") };
}
// Anchor on the Bucharest calendar day, then do ISO math in UTC so DST never
// shifts which day a date lands on.
const nowP = parts(dateArg ? new Date(dateArg + "T12:00:00") : new Date());
const ANCHOR = new Date(`${nowP.y}-${nowP.m}-${nowP.d}T12:00:00Z`);

function isoWeek(d: Date): { year: number; week: number } {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (x.getUTCDay() + 6) % 7;            // Mon=0 … Sun=6
  x.setUTCDate(x.getUTCDate() - dayNum + 3);          // Thursday of this week
  const firstThu = new Date(Date.UTC(x.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((x.getTime() - firstThu.getTime()) / (7 * 24 * 3600 * 1000));
  return { year: x.getUTCFullYear(), week };
}

const ISO = isoWeek(ANCHOR);
const WEEK_LABEL = `${ISO.year}-W${String(ISO.week).padStart(2, "0")}`;
const WEEKLY_REL = `Daily Notes/${ISO.year}/W${String(ISO.week).padStart(2, "0")}.md`;

// the seven calendar dates (Mon..Sun) of this ISO week, at UTC noon
const mondayDayNum = (ANCHOR.getUTCDay() + 6) % 7;
const MONDAY = new Date(ANCHOR);
MONDAY.setUTCDate(ANCHOR.getUTCDate() - mondayDayNum);
const WEEK_DATES = Array.from({ length: 7 }, (_, i) => {
  const x = new Date(MONDAY); x.setUTCDate(MONDAY.getUTCDate() + i); return x;
});
const SUNDAY = WEEK_DATES[6];

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
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function between(body: string, start: string, end: string): string | null {
  const m = body.match(new RegExp(escapeRe(start) + "([\\s\\S]*?)" + escapeRe(end)));
  return m ? m[1].trim() : null;
}

// ---- signal gathering ------------------------------------------------------
// 1. the week's daily digests — already distilled by the daily writer.
function weekDigests(): string[] {
  const out: string[] = [];
  for (const x of WEEK_DATES) {
    const p = parts(x);
    const rel = `Daily Notes/${p.y}/${p.m}/${p.d} (${p.ddd}).md`;
    const inner = between(readVault(rel), DIGEST_START, DIGEST_END);
    if (!inner) continue;
    // drop the "## Daily digest" heading the daily writer prepends
    const text = inner.replace(/^##\s+Daily digest\s*/i, "").trim();
    if (text) out.push(`${p.y}-${p.m}-${p.d} (${p.ddd}):\n${text}`);
  }
  return out;
}

// 2. git oneline across ~/projects/* for the week — backup context so there is
//    material even on weeks the daily writer never ran.
function weekGit(): string[] {
  const since = `${parts(MONDAY).y}-${parts(MONDAY).m}-${parts(MONDAY).d} 00:00`;
  const until = `${parts(SUNDAY).y}-${parts(SUNDAY).m}-${parts(SUNDAY).d} 23:59`;
  const out: string[] = [];
  let dirs: fs.Dirent[];
  try { dirs = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true }); } catch { return out; }
  for (const e of dirs) {
    if (!e.isDirectory() || SKIP_REPOS.has(e.name)) continue;
    const dir = path.join(PROJECTS_ROOT, e.name);
    if (!fs.existsSync(path.join(dir, ".git"))) continue;
    let log = "";
    try {
      log = execFileSync(
        "git",
        ["-C", dir, "log", `--since=${since}`, `--until=${until}`, "--no-merges", "--pretty=format:  %h %s"],
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
      ).trim();
    } catch { continue; }
    if (log) out.push(`=== ${e.name} ===\n${log}`);
  }
  return out;
}

// ---- Opus draft generation -------------------------------------------------
interface Draft { angle: string; text: string; }
function generate(digests: string[], git: string[], manual: string): Draft[] {
  let prompt = fs.readFileSync(PROMPT_TXT, "utf8").trim() + "\n\n";
  prompt += `=== INPUT — ISO week ${WEEK_LABEL} ===\n`;
  if (digests.length) prompt += `\nDaily digests (already summarized per day):\n${digests.join("\n\n")}\n`;
  if (manual.trim()) prompt += `\nManually curated items (the author wrote these — prioritize and treat as the most important signal):\n${manual.trim()}\n`;
  if (git.length) prompt += `\nGit commits this week (raw, backup context only):\n${git.join("\n\n")}\n`;
  prompt += `\nReturn ONLY the JSON array described above.\n`;

  const raw = execFileSync(
    HEADROOM,
    ["wrap", "claude", "--", "-p", prompt, "--model", "opus", "--permission-mode", "bypassPermissions",
     "--disallowed-tools", "Bash", "Edit", "Write", "NotebookEdit", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Task",
     "--output-format", "json"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, HOME: os.homedir() } }
  );
  const envLine = raw.split("\n").reverse().find((l) => l.trim().startsWith('{"type":"result"')) ?? "";
  const result = (() => { try { return JSON.parse(envLine).result ?? ""; } catch { return ""; } })();
  const jsonText = result.replace(/^[\s\S]*?(\[[\s\S]*\])[\s\S]*$/, "$1");
  const drafts = JSON.parse(jsonText) as Draft[];
  if (!Array.isArray(drafts) || !drafts.every((d) => d && typeof d.text === "string"))
    throw new Error("generate: model did not return a valid draft array");
  return drafts.filter((d) => d.text.trim());
}

// ---- weekly note (managed drafts block, preserved manual block) ------------
function upsertDrafts(drafts: Draft[]) {
  const draftsBlock =
    `${DRAFTS_START}\n## LinkedIn drafts — week ${WEEK_LABEL}\n\n` +
    drafts.map((d, i) => `### Draft ${i + 1} — ${d.angle?.trim() || "post"}\n\n${d.text.trim()}\n`).join("\n---\n\n") +
    `\n${DRAFTS_END}`;

  let body = readVault(WEEKLY_REL);
  if (!body) {
    body =
      `# ${WEEK_LABEL}\n\n` +
      `${MANUAL_START}\n${MANUAL_HINT}\n${MANUAL_END}\n\n` +
      `${draftsBlock}\n`;
  } else {
    // ensure a manual block exists (preserved as-is; never overwritten)
    if (!(body.includes(MANUAL_START) && body.includes(MANUAL_END)))
      body = body.replace(/^# .*\n/, (h) => `${h}\n${MANUAL_START}\n${MANUAL_HINT}\n${MANUAL_END}\n`);
    // replace or append the drafts block
    if (body.includes(DRAFTS_START) && body.includes(DRAFTS_END))
      body = body.replace(new RegExp(escapeRe(DRAFTS_START) + "[\\s\\S]*?" + escapeRe(DRAFTS_END)), draftsBlock);
    else
      body = body.replace(/\s*$/, "\n\n") + draftsBlock + "\n";
  }

  if (SHADOW) {
    const dump = path.join(__dirname, "..", ".vault-keeper", `shadow-${WEEK_LABEL}.md`);
    fs.mkdirSync(path.dirname(dump), { recursive: true });
    fs.writeFileSync(dump, `========== ${WEEKLY_REL} ==========\n${body}`);
    console.log(`vault-weekly ${WEEK_LABEL}: shadow → ${dump}`);
  } else {
    writeAtomic(WEEKLY_REL, body);
    console.log(`vault-weekly ${WEEK_LABEL}: wrote ${drafts.length} draft(s) → ${WEEKLY_REL}`);
  }
}

// ---- main ------------------------------------------------------------------
function main() {
  const digests = weekDigests();
  const git = weekGit();
  const manual = between(readVault(WEEKLY_REL), MANUAL_START, MANUAL_END)?.split(MANUAL_HINT).join("").trim() ?? "";

  if (!digests.length && !git.length && !manual) {
    console.log(`vault-weekly ${WEEK_LABEL}: no activity this week; nothing to draft`);
    return;
  }
  console.log(`vault-weekly ${WEEK_LABEL}: ${digests.length} daily digest(s), ${git.length} active repo(s)${manual ? ", manual items present" : ""}`);

  const drafts = generate(digests, git, manual);
  if (!drafts.length) { console.log(`vault-weekly ${WEEK_LABEL}: model produced no usable drafts`); return; }
  upsertDrafts(drafts);
}

main();
