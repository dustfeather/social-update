import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { getWeekItems, saveDraft } from "./db";

const PROMPT_PATH = path.join(__dirname, "..", "prompt.txt");
const HUMANIZE_PROMPT_PATH = path.join(__dirname, "..", "humanize-prompt.txt");
const ITEM_BODY_CAP = 500; // keep each item compact so the prompt stays bounded

export interface Draft {
  angle: string;
  /** Markdown. The stored source of a post; the plain text a composer receives is
   *  derived from it in the browser (web/src/draft-text.ts) and never persisted. */
  md: string;
}

// Pipe the assembled prompt to the local claude CLI and return the raw .result string.
function runClaude(input: string, extraArgs: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", "--output-format", "json", ...extraArgs], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.trim()}`));
      try {
        const env = JSON.parse(out);
        if (env.is_error) return reject(new Error(`claude error: ${env.result ?? env.subtype}`));
        if (typeof env.result !== "string") return reject(new Error("claude envelope missing string .result"));
        resolve(env.result);
      } catch (e) {
        reject(new Error(`failed to parse claude envelope: ${(e as Error).message}`));
      }
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

// The model is told to emit a JSON array; tolerate it being wrapped in a code fence.
function parseDrafts(result: string): Draft[] {
  let s = result.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const arr = JSON.parse(s);
  if (!Array.isArray(arr)) throw new Error("model output was not a JSON array");
  return arr
    .filter((d) => d && typeof d.md === "string")
    .map((d) => ({ angle: String(d.angle ?? ""), md: String(d.md) }));
}

// tags is a JSON array written by the tagging pass; NULL until a run tags it.
function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function buildInput(promptText: string, items: ReturnType<typeof getWeekItems>, manualText: string): string {
  const lines: string[] = [promptText.trim(), "", "=== ACTIVITY ITEMS ==="];
  for (const it of items) {
    // Tags are the run's own cross-session vocabulary — they say what a week was
    // ABOUT in a way the individual titles do not, so the model sees them too.
    const tags = parseTags(it.tags);
    const suffix = tags.length ? `  {${tags.join(", ")}}` : "";
    lines.push(`- [${it.source}] ${it.title ?? ""}${suffix}`.trimEnd());
    if (it.body) lines.push(`    ${it.body.slice(0, ITEM_BODY_CAP).replace(/\n+/g, " ").trim()}`);
  }
  const manual = manualText.trim();
  if (manual) {
    lines.push("", "=== MANUAL ITEMS (author-curated) ===", manual);
  }
  return lines.join("\n");
}

// A second pass over the drafts, run through the `humanizer` skill. It is a separate
// call rather than another paragraph in prompt.txt for two reasons: the skill is an
// EDITING pass over finished prose, which is the shape it was written for, and asking
// one call to both invent the posts and police its own voice reliably costs the JSON
// contract — the skill's own persona starts answering instead of the format.
//
// Nothing here may fail a generation. A polish pass that throws, times out, returns a
// different number of drafts or returns junk leaves the originals standing: an unpolished
// draft is worth having, a lost one is not.
export function mergeHumanized(drafts: Draft[], result: string): Draft[] {
  let edited: unknown;
  try {
    let t = result.trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) t = fence[1].trim();
    edited = JSON.parse(t);
  } catch {
    return drafts;
  }
  if (!Array.isArray(edited) || edited.length !== drafts.length) return drafts;
  return drafts.map((d, i) => {
    const md = edited[i];
    // An empty or non-string edit is a dropped draft, which is the one outcome worse
    // than an unedited one.
    return typeof md === "string" && md.trim() ? { ...d, md: md.trim() } : d;
  });
}

async function humanize(drafts: Draft[]): Promise<Draft[]> {
  if (process.env.HUMANIZE === "0" || !drafts.length) return drafts;
  let prompt: string;
  try {
    prompt = fs.readFileSync(HUMANIZE_PROMPT_PATH, "utf8");
  } catch {
    return drafts;
  }
  try {
    const input = `${prompt.trim()}\n\n${JSON.stringify(drafts.map((d) => d.md), null, 2)}`;
    // The editing tools are taken away for this call. Left with them, the skill does
    // what an editor naturally does — writes the edited copy somewhere and reports
    // "Done" — and the JSON array the caller needs never arrives.
    return mergeHumanized(drafts, await runClaude(input, ["--disallowedTools", "Write,Edit,NotebookEdit"]));
  } catch (e) {
    console.warn(`[generate] humanizer pass skipped — ${(e as Error).message}`);
    return drafts;
  }
}

export async function generateDrafts(
  week: string,
  manualText: string
): Promise<{ draftId: number; drafts: Draft[] }> {
  const promptText = fs.readFileSync(PROMPT_PATH, "utf8");
  const items = getWeekItems(week);
  if (items.length === 0 && !manualText.trim()) {
    throw new Error(`no items for ${week} and no manual text — nothing to generate from`);
  }
  const input = buildInput(promptText, items, manualText);
  const result = await runClaude(input);
  const drafts = await humanize(parseDrafts(result));

  const draftId = saveDraft({
    iso_week: week,
    input_snapshot: JSON.stringify({ itemIds: items.map((i) => i.id), manualText }),
    prompt_used: promptText,
    output: JSON.stringify(drafts),
  });
  return { draftId, drafts };
}
