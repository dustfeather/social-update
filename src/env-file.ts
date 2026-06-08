import fs from "fs";
import path from "path";

// The collector reads .env fresh on each run, so edits here apply to the next collection.
const ENV_PATH = path.join(__dirname, "..", ".env");
const KEY_RE = (key: string) => new RegExp(`^\\s*${key}\\s*=`, "i");

// Read a single key from the .env file (not process.env, which is stale post-startup).
export function readEnvVar(key: string): string {
  let text: string;
  try {
    text = fs.readFileSync(ENV_PATH, "utf8");
  } catch {
    return process.env[key] ?? "";
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m && m[1] === key) return m[2].trim().replace(/^["']|["']$/g, "");
  }
  return "";
}

// Upsert a single key in .env, preserving all other lines and comments.
export function writeEnvVar(key: string, value: string): void {
  let lines: string[];
  try {
    lines = fs.readFileSync(ENV_PATH, "utf8").split("\n");
  } catch {
    lines = [];
  }
  const newLine = `${key}="${value}"`;
  let found = false;
  lines = lines.map((l) => {
    if (KEY_RE(key).test(l)) {
      found = true;
      return newLine;
    }
    return l;
  });
  if (!found) {
    if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push(newLine);
  }
  fs.writeFileSync(ENV_PATH, lines.join("\n"));
}
