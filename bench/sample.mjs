// Picks the benchmark's fixed session sample.
//
// Fixed, not random: every model must be judged on identical input, and a
// regression three iterations later must be reproducible. The sample is stratified
// by transcript size because size is what varies the task — a 40-turn session and a
// 900-turn one are different problems, and a model that only handles the small ones
// would look fine on an unstratified draw.

import fs from "fs";
import path from "path";
import { excerpt, sessionCwd } from "./excerpt.mjs";

const ROOT = path.join(process.env.HOME, ".claude", "projects");

const HOME = process.env.HOME ?? "";

// A readable name for where the work happened. The transcript's own cwd is the
// truth; the directory name is a lossy encoding of it and is only a fallback.
function projectName(transcriptPath, dirName) {
  const cwd = sessionCwd(transcriptPath);
  if (cwd) return cwd.startsWith(HOME) ? cwd.slice(HOME.length).replace(/^\//, "~/") || "~" : cwd;
  return dirName.replace(/^-home-dustfeather-/, "").replace(/-/g, "/");
}

export function allSessions() {
  const out = [];
  for (const dir of fs.readdirSync(ROOT)) {
    const full = path.join(ROOT, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith(".jsonl")) continue;
      const p = path.join(full, f);
      out.push({
        session_id: f.replace(/\.jsonl$/, ""),
        project: projectName(p, dir),
        path: p,
        size: fs.statSync(p).size,
        mtime: fs.statSync(p).mtime.toISOString(),
      });
    }
  }
  return out.sort((a, b) => a.size - b.size);
}

/** `n` sessions spread evenly across the size distribution, deterministically. */
export function pickSample(n = 12) {
  // A session whose excerpt is empty carries nothing to summarize — usually a
  // transcript that never got past the first prompt. Judging a model on those
  // measures nothing about the model.
  const usable = allSessions().filter((s) => {
    try { return excerpt(s.path).text.length > 800; } catch { return false; }
  });
  const step = usable.length / n;
  return Array.from({ length: n }, (_, i) => usable[Math.floor(i * step + step / 2)]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sample = pickSample(Number(process.argv[2] ?? 12));
  const rows = sample.map((s) => {
    const e = excerpt(s.path);
    return { ...s, chars: e.text.length, turns: e.turns, truncated: e.truncated };
  });
  for (const r of rows) {
    console.log(
      `${(r.size / 1048576).toFixed(2).padStart(6)}MB  turns=${String(r.turns).padStart(4)}  ` +
      `excerpt=${String(r.chars).padStart(6)}ch (~${Math.round(r.chars / 4)}tok)` +
      `${r.truncated ? " [trunc]" : ""}  ${r.project}`
    );
  }
  const tot = rows.reduce((a, r) => a + r.chars, 0);
  console.log(`\n${rows.length} sessions, mean excerpt ${Math.round(tot / rows.length / 4)} tok`);
}
