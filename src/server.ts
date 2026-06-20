import express from "express";
import path from "path";
import fs from "fs";
import { config } from "dotenv";
import db, {
  getDrafts,
  insertItems,
  getSetting,
  setSetting,
  enqueueRun,
  claimNextRun,
  finishRun,
  latestRun,
  setItemIgnored,
  type ItemInput,
} from "./db";
import { generateDrafts } from "./generate";

config();

const PORT = Number(process.env.PORT ?? 4000);
const WEEK_RE = /^\d{4}-W\d{2}$/;

const app = express();
// Collectors POST full GitHub event payloads (raw_json) in a batch — well over the
// 100kb default. 32mb mirrors the collector's gh --paginate buffer ceiling.
app.use(express.json({ limit: "32mb" }));

// Prepared statements (reused across requests).
const weeksStmt = db.prepare(
  `SELECT iso_week AS week, COUNT(*) AS count
     FROM items
    WHERE iso_week IS NOT NULL
    GROUP BY iso_week
    ORDER BY iso_week DESC`
);
const itemsStmt = db.prepare(
  `SELECT id, source, external_id, title, body, url, occurred_at, iso_week, collected_at, ignored
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

// Toggle an item's ignored flag. Ignored items stay tracked but are excluded
// from draft generation.
app.patch("/api/items/:id/ignore", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "id must be an integer" });
  const ignored = req.body?.ignored === true;
  if (!setItemIgnored(id, ignored)) return res.status(404).json({ error: "item not found" });
  res.json({ id, ignored });
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

// Collector ingest. Collectors run locally but POST here (over the WARP network)
// instead of opening the SQLite file directly — the DB lives in the cluster now.
// Body: { items: ItemInput[] }. iso_week/collected_at are derived server-side.
app.post("/api/ingest", (req, res) => {
  const items = req.body?.items;
  if (!Array.isArray(items)) {
    return res.status(400).json({ error: "body must be { items: ItemInput[] }" });
  }
  for (const it of items) {
    if (!it || typeof it.source !== "string" || typeof it.external_id !== "string") {
      return res.status(400).json({ error: "each item needs a string source and external_id" });
    }
  }
  const inserted = insertItems(items as ItemInput[]);
  res.json({ received: items.length, inserted });
});

// Collector settings, stored in the DB so the remote UI and the local collector
// share one value (collector reads this back via GET on each run).
app.get("/api/settings", (_req, res) => {
  res.json({ excludeRepos: parseList(getSetting("GITHUB_EXCLUDE_REPOS")) });
});

app.put("/api/settings", (req, res) => {
  const raw = req.body?.excludeRepos;
  const list = Array.isArray(raw) ? raw.map((s) => String(s).trim()).filter(Boolean) : [];
  setSetting("GITHUB_EXCLUDE_REPOS", list.join(","));
  res.json({ excludeRepos: list });
});

// --- Manual collection trigger ----------------------------------------------
// Collectors run on the local WSL box (they need its browser/vault/CLIs), so the
// UI can't run them directly. Instead a run is enqueued here and the local poller
// (GET /api/collect/next) claims it, runs the watchdog, and reports back.

// Enqueue a run from the UI button (source=manual) or the daily timer (source=daily).
// Single-flight: a second request while one is pending/running returns 409 with the
// active run so the button can show "already running" instead of stacking passes.
app.post("/api/collect", (req, res) => {
  const source = req.body?.source === "daily" ? "daily" : "manual";
  const { run, alreadyActive } = enqueueRun(source);
  res.status(alreadyActive ? 409 : 202).json({ run, alreadyActive });
});

// Local poller claims the oldest pending run. 204 when nothing is queued.
app.post("/api/collect/next", (_req, res) => {
  const run = claimNextRun();
  if (!run) return res.status(204).end();
  res.json({ run });
});

// Local poller reports the outcome of a claimed run.
app.post("/api/collect/:id/done", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "id must be an integer" });
  const inserted = req.body?.inserted;
  const error = req.body?.error;
  finishRun(id, {
    inserted: typeof inserted === "number" ? inserted : undefined,
    error: typeof error === "string" && error ? error : undefined,
  });
  res.json({ ok: true });
});

// Latest run — drives the button state and the completion notification.
app.get("/api/collect/status", (_req, res) => res.json({ run: latestRun() }));

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
