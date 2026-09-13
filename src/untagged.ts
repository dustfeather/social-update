import { config } from "dotenv";
import type { TagCandidate } from "./tag-pass";

config({ quiet: true });

// Reading items back out for the backfill, over the same two roads the writes
// take: the cluster's HTTP API when INGEST_URL is set, a local SQLite file
// otherwise. See sink.ts — this is its read-side twin, kept separate because
// sink.ts is about getting collected work IN.
//
// What a row can give a tagging pass: the summary files are long gone by the
// time anything is in the DB (the collector deletes each one as it imports it),
// so the candidate is rebuilt from the columns the importer wrote. `title` is
// "<project>: <title>" and `body` is the summary followed by "- " highlight
// lines — claude-import.ts's toItem() is the contract, and this is its inverse.
// `outcome` does not survive the trip: it lives in raw_json, which /api/items
// does not return. A tag rarely turns on it, so the pass does without rather
// than growing an endpoint to fetch it.
const INGEST_URL = process.env.INGEST_URL;

export interface ItemRow {
  external_id: string | null;
  title: string | null;
  body: string | null;
  tags: string | null;
}

/** Split "<project>: <title>" back apart. A title with no project prefix keeps
 *  the whole string — better an empty project than a title cut at a colon that
 *  was part of the sentence. */
export function candidateFromRow(row: ItemRow): TagCandidate | null {
  if (!row.external_id) return null;
  const full = row.title ?? "";
  const sep = full.indexOf(": ");
  const project = sep > 0 ? full.slice(0, sep) : "";
  const title = sep > 0 ? full.slice(sep + 2) : full;
  const highlights = (row.body ?? "")
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim())
    .filter(Boolean);
  if (!title && !highlights.length) return null; // nothing to tag from
  return { session_id: row.external_id, project, title, highlights };
}

/** Rows of `source` whose tags column is NULL — "not tagged yet", as distinct
 *  from "[]", a tag set something deliberately left empty. */
export function untaggedFrom(rows: ItemRow[], source: string, rowSource: (r: ItemRow) => string): TagCandidate[] {
  const out: TagCandidate[] = [];
  for (const r of rows) {
    if (rowSource(r) !== source) continue;
    if (r.tags !== null) continue;
    const c = candidateFromRow(r);
    if (c) out.push(c);
  }
  return out;
}

async function getJson(url: URL): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url.pathname} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// The API has no "untagged" route, and adding one would mean a redeploy before a
// backfill could run. /api/weeks plus a page walk gets there with what is
// already deployed, at one request per 200 items.
const PAGE = 200;

/** `week` narrows to one ISO week ("2026-W37"); omitted, it walks the whole
 *  backlog. Narrow deliberately: the vocabulary is shared across whatever the
 *  pass is given, so a week tagged on its own gets a vocabulary of its own. */
export async function fetchUntagged(source: string, week?: string): Promise<TagCandidate[]> {
  if (INGEST_URL) {
    // /api/weeks rather than trusting the argument: a week with no items is a
    // typo worth reporting, not an empty pass that looks like "nothing untagged".
    const all = (await getJson(new URL("/api/weeks", INGEST_URL))) as Array<{ week: string }>;
    const weeks = week ? all.filter((w) => w.week === week) : all;
    if (week && !weeks.length) throw new Error(`no week "${week}" — /api/weeks knows ${all.length} week(s)`);
    const out: TagCandidate[] = [];
    for (const { week } of weeks) {
      for (let page = 1; ; page++) {
        const url = new URL("/api/items", INGEST_URL);
        url.searchParams.set("week", week);
        url.searchParams.set("page", String(page));
        url.searchParams.set("limit", String(PAGE));
        const body = (await getJson(url)) as { total: number; items: Array<ItemRow & { source: string }> };
        out.push(...untaggedFrom(body.items, source, (r) => (r as any).source));
        if (page * PAGE >= body.total || !body.items.length) break;
      }
    }
    return out;
  }

  const { getUntaggedItems } = require("./db") as typeof import("./db");
  return getUntaggedItems(source, week)
    .map(candidateFromRow)
    .filter((c): c is TagCandidate => c !== null);
}
