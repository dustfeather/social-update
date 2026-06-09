import { config } from "dotenv";
import type { ItemInput } from "./db";

config();

// Where collected items go. With INGEST_URL set (the k3s deployment), collectors
// POST to the remote server's /api/ingest instead of opening a local SQLite file.
// Unset (pure-local dev) → lazy-require ./db and insert directly.
//
// No auth token: collector and cluster share the WARP private network (same gate
// as the web UI), so /api/ingest is unreachable from outside it.
//
// `import type { ItemInput }` is erased at compile time, so this module never
// pulls in db.ts (and never opens a local DB) unless the local branch runs.
const INGEST_URL = process.env.INGEST_URL;

export async function insertItems(items: ItemInput[]): Promise<number> {
  if (!items.length) return 0;

  if (INGEST_URL) {
    const res = await fetch(new URL("/api/ingest", INGEST_URL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items }),
    });
    if (!res.ok) {
      throw new Error(`ingest POST ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const body = (await res.json()) as { inserted?: number };
    return Number(body.inserted ?? 0);
  }

  // Local fallback — require lazily so importing this module never opens a DB.
  const { insertItems: insertLocal } = require("./db") as typeof import("./db");
  return insertLocal(items);
}
