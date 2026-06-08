import fs from "fs/promises";
import path from "path";
import { config } from "dotenv";
import { insertItems, expandHome, type ItemInput } from "./db";

config();

const CLAUDE_PROJECTS = expandHome(process.env.CLAUDE_PROJECTS ?? "~/.claude/projects");

const MAX_BODY = 4000;
const MAX_TITLE = 120;

// Extract plain text from a message.content that may be a string or a block array.
function firstText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const block = content.find(
      (b) => b && typeof b === "object" && (b as any).type === "text" && typeof (b as any).text === "string"
    );
    return block ? (block as any).text : "";
  }
  return "";
}

// A genuine typed prompt — not a slash-command wrapper, caveat block, or tool result.
function isRealPrompt(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // Command/caveat/system wrappers are XML-ish and start with "<".
  if (t.startsWith("<")) return false;
  return true;
}

// First human-typed prompt in a session, or null if none found.
function findFirstPrompt(lines: string[]): string | null {
  for (const line of lines) {
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // schema drift / partial line — skip defensively
    }
    if (o?.type !== "user" || o?.message?.role !== "user") continue;
    if (o.isSidechain === true || o.isMeta === true) continue; // subagent / meta turns
    const text = firstText(o.message.content);
    if (isRealPrompt(text)) return text.trim();
  }
  return null;
}

// cwd recorded on session entries; falls back to decoding the project dir name.
function findCwd(lines: string[], projectDir: string): string {
  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      if (typeof o?.cwd === "string" && o.cwd) return o.cwd;
    } catch {
      /* skip */
    }
  }
  return projectDir.replace(/^-/, "/").replace(/-/g, "/");
}

export async function collectClaude(): Promise<number> {
  let projectDirs: string[];
  try {
    projectDirs = (await fs.readdir(CLAUDE_PROJECTS, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return 0; // no projects dir — nothing to collect
  }

  const rows: ItemInput[] = [];
  for (const dir of projectDirs) {
    const dirPath = path.join(CLAUDE_PROJECTS, dir);
    let sessionFiles: string[];
    try {
      sessionFiles = (await fs.readdir(dirPath)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of sessionFiles) {
      const full = path.join(dirPath, file);
      let content: string;
      let mtimeMs: number;
      try {
        const stat = await fs.stat(full);
        mtimeMs = stat.mtimeMs;
        content = await fs.readFile(full, "utf8");
      } catch {
        continue;
      }
      const lines = content.split("\n").filter(Boolean);
      const prompt = findFirstPrompt(lines);
      if (!prompt) continue; // no human prompt → not worth surfacing

      const sessionId = path.basename(file, ".jsonl");
      const project = path.basename(findCwd(lines, dir));
      rows.push({
        source: "claude",
        external_id: sessionId,
        title: `${project}: ${prompt.split("\n")[0]}`.slice(0, MAX_TITLE),
        body: prompt.slice(0, MAX_BODY),
        url: null,
        occurred_at: new Date(mtimeMs).toISOString(),
        raw_json: JSON.stringify({ sessionId, project }),
      });
    }
  }
  return insertItems(rows);
}
