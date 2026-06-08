import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { getWeekItems, saveDraft } from "./db";

const PROMPT_PATH = path.join(__dirname, "..", "prompt.txt");
const ITEM_BODY_CAP = 500; // keep each item compact so the prompt stays bounded

export interface Draft {
  angle: string;
  text: string;
}

// Pipe the assembled prompt to the local claude CLI and return the raw .result string.
function runClaude(input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", "--output-format", "json"], {
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
    .filter((d) => d && typeof d.text === "string")
    .map((d) => ({ angle: String(d.angle ?? ""), text: String(d.text) }));
}

function buildInput(promptText: string, items: ReturnType<typeof getWeekItems>, manualText: string): string {
  const lines: string[] = [promptText.trim(), "", "=== ACTIVITY ITEMS ==="];
  for (const it of items) {
    lines.push(`- [${it.source}] ${it.title ?? ""}`.trimEnd());
    if (it.body) lines.push(`    ${it.body.slice(0, ITEM_BODY_CAP).replace(/\n+/g, " ").trim()}`);
  }
  const manual = manualText.trim();
  if (manual) {
    lines.push("", "=== MANUAL ITEMS (author-curated) ===", manual);
  }
  return lines.join("\n");
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
  const drafts = parseDrafts(result);

  const draftId = saveDraft({
    iso_week: week,
    input_snapshot: JSON.stringify({ itemIds: items.map((i) => i.id), manualText }),
    prompt_used: promptText,
    output: JSON.stringify(drafts),
  });
  return { draftId, drafts };
}
