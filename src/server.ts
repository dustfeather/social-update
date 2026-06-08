import express from "express";
import path from "path";
import fs from "fs";
import { config } from "dotenv";
import db, { getDrafts } from "./db";
import { generateDrafts } from "./generate";
import { readEnvVar, writeEnvVar } from "./env-file";

config();

const PORT = Number(process.env.PORT ?? 4000);
const WEEK_RE = /^\d{4}-W\d{2}$/;

const app = express();
app.use(express.json());

// Prepared statements (reused across requests).
const weeksStmt = db.prepare(
  `SELECT iso_week AS week, COUNT(*) AS count
     FROM items
    WHERE iso_week IS NOT NULL
    GROUP BY iso_week
    ORDER BY iso_week DESC`
);
const itemsStmt = db.prepare(
  `SELECT id, source, external_id, title, body, url, occurred_at, iso_week, collected_at
     FROM items
    WHERE iso_week = ?
    ORDER BY occurred_at DESC
    LIMIT ? OFFSET ?`
);
const itemsCountStmt = db.prepare(`SELECT COUNT(*) AS total FROM items WHERE iso_week = ?`);

// Distinct weeks present, newest first, each with its item count.
app.get("/api/weeks", (_req, res) => {
  res.json(weeksStmt.all());
});

// Paginated, read-only item viewer for one ISO week.
app.get("/api/items", (req, res) => {
  const week = String(req.query.week ?? "");
  if (!WEEK_RE.test(week)) {
    return res.status(400).json({ error: "week must be in YYYY-Www format" });
  }
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = (page - 1) * limit;

  const total = (itemsCountStmt.get(week) as { total: number }).total;
  const items = itemsStmt.all(week, limit, offset);
  res.json({ week, page, limit, total, items });
});

// Draft history for a week (output parsed back into card arrays).
app.get("/api/drafts", (req, res) => {
  const week = String(req.query.week ?? "");
  if (!WEEK_RE.test(week)) {
    return res.status(400).json({ error: "week must be in YYYY-Www format" });
  }
  const rows = getDrafts(week).map((r) => ({
    id: r.id,
    created_at: r.created_at,
    iso_week: r.iso_week,
    drafts: safeParse(r.output),
  }));
  res.json(rows);
});

// Generate drafts for a week from its items + optional manual text via the claude CLI.
app.post("/api/generate", async (req, res) => {
  const week = String(req.body?.week ?? "");
  const manualText = String(req.body?.manualText ?? "");
  if (!WEEK_RE.test(week)) {
    return res.status(400).json({ error: "week must be in YYYY-Www format" });
  }
  try {
    const result = await generateDrafts(week, manualText);
    res.json(result);
  } catch (err) {
    console.error("[generate]", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "generation failed" });
  }
});

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return [];
  }
}

const parseList = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

// Distinct GitHub repos seen in collected items — the pick-list for the exclude UI.
const githubReposStmt = db.prepare(
  `SELECT DISTINCT json_extract(raw_json, '$.repo.name') AS name
     FROM items
    WHERE source = 'github' AND name IS NOT NULL
    ORDER BY name`
);
app.get("/api/github-repos", (_req, res) => {
  res.json((githubReposStmt.all() as { name: string }[]).map((r) => r.name));
});

// Collector settings backed by .env. GET reads the file (process.env is stale post-startup).
app.get("/api/settings", (_req, res) => {
  res.json({ excludeRepos: parseList(readEnvVar("GITHUB_EXCLUDE_REPOS")) });
});

// PUT persists to .env; applies on the next collection run (the collector is a separate process).
app.put("/api/settings", (req, res) => {
  const raw = req.body?.excludeRepos;
  const list = Array.isArray(raw) ? raw.map((s) => String(s).trim()).filter(Boolean) : [];
  writeEnvVar("GITHUB_EXCLUDE_REPOS", list.join(","));
  res.json({ excludeRepos: list });
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Serve the built React SPA (web/dist) when present; SPA-fallback non-API routes.
const WEB_DIST = path.join(__dirname, "..", "web", "dist");
if (fs.existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(WEB_DIST, "index.html")));
} else {
  console.warn(`[server] ${WEB_DIST} not built — run "npm run build:web"; API still available.`);
}

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
