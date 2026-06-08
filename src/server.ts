import express from "express";
import { config } from "dotenv";
import db from "./db";

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

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
