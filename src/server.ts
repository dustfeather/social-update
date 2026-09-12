import express from "express";
import path from "path";
import fs from "fs";
import { config } from "dotenv";
import db, {
  getDrafts,
  updateDraftOutput,
  insertItems,
  setItemTags,
  enqueueRun,
  claimNextRun,
  finishRun,
  latestRun,
  setItemIgnored,
  type ItemInput,
} from "./db";
import { generateDrafts } from "./generate";

config({ quiet: true });

const PORT = Number(process.env.PORT ?? 4000);
const WEEK_RE = /^\d{4}-W\d{2}$/;

const app = express();
// A collection run POSTs every session summary of the run in one batch, each with
// its raw_json. Well over the 100kb default; 32mb leaves room for a long backlog
// draining in a single pass.
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
  `SELECT id, source, external_id, title, body, url, occurred_at, iso_week, collected_at, ignored, tags
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

// Save edited drafts back onto an existing row. The UI edits in place (each
// draft carries `html` for the rich-text editor plus the `text` that is what
// actually gets pasted into a social composer), so this overwrites `output`
// rather than inserting — a regenerate is what creates a new row.
app.put("/api/drafts/:id", (req, res) => {
  const id = Number(req.params.id);
  const drafts = req.body?.drafts;
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "id must be a positive integer" });
  }
  if (!Array.isArray(drafts) || drafts.some((d) => typeof d?.text !== "string")) {
    return res.status(400).json({ error: "drafts must be an array of { angle, text, html? }" });
  }
  const clean = drafts.map((d: any) => ({
    angle: String(d.angle ?? ""),
    text: String(d.text),
    html: typeof d.html === "string" ? d.html : undefined,
  }));
  if (!updateDraftOutput(id, JSON.stringify(clean))) {
    return res.status(404).json({ error: `no draft row ${id}` });
  }
  res.json({ ok: true });
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

// Item batch from a collection run. Body: { items: ItemInput[] }. Upserts, so a
// session resummarized after it grew replaces its earlier row. No auth token: the
// collector reaches this over the same WARP private network as the web UI.
app.post("/api/ingest", (req, res) => {
  const items = req.body?.items;
  if (!Array.isArray(items)) {
    return res.status(400).json({ error: "items must be an array" });
  }
  for (const [i, item] of items.entries()) {
    if (typeof item?.source !== "string" || !item.source) {
      return res.status(400).json({ error: `items[${i}].source is required` });
    }
    if (typeof item?.external_id !== "string" || !item.external_id) {
      return res.status(400).json({ error: `items[${i}].external_id is required` });
    }
  }
  try {
    res.json({ received: items.length, inserted: insertItems(items as ItemInput[]) });
  } catch (err) {
    console.error("[ingest]", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "ingest failed" });
  }
});

// Tag assignment from a collection run. Body: { source, tags: { external_id: [...] } }.
// Keyed by external_id because the tagging pass works from the summary files and
// never sees the DB's primary keys.
app.post("/api/items/tags", (req, res) => {
  const source = String(req.body?.source ?? "");
  const tags = req.body?.tags;
  if (!source) return res.status(400).json({ error: "source is required" });
  if (typeof tags !== "object" || tags === null || Array.isArray(tags)) {
    return res.status(400).json({ error: "tags must be an object of { external_id: string[] }" });
  }
  for (const [id, list] of Object.entries(tags)) {
    if (!Array.isArray(list) || list.some((t) => typeof t !== "string")) {
      return res.status(400).json({ error: `tags["${id}"] must be an array of strings` });
    }
  }
  let updated = 0;
  for (const [external_id, list] of Object.entries(tags as Record<string, string[]>)) {
    if (setItemTags(source, external_id, list)) updated++;
  }
  res.json({ received: Object.keys(tags).length, updated });
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
