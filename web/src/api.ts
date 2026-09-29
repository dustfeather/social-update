// Thin typed wrapper over the backend API.

import { normalizeDrafts } from "./draft-text";
import { createLineSplitter, type GenerateStage } from "./progress";

export interface WeekRow {
  week: string;
  count: number;
}

export interface Item {
  id: number;
  source: string;
  /** Stable id within the source — for claude rows, the session's UUID. */
  external_id: string | null;
  title: string | null;
  body: string | null;
  url: string | null;
  occurred_at: string | null;
  iso_week: string | null;
  collected_at: string | null;
  ignored: number;
  /** JSON array of strings, assigned by the collection run's tagging pass. NULL until tagged. */
  tags: string | null;
}

export interface ItemsPage {
  week: string;
  page: number;
  limit: number;
  total: number;
  items: Item[];
}

export interface Draft {
  angle: string;
  /** Markdown — the stored source, and the only form of the post that is saved. */
  md: string;
  /** Plain text, on rows written before Markdown was the format. Read through
   *  `draftMd()`, never written: the paste-ready text is derived from `md` at the
   *  point of use so the two cannot drift apart. */
  text?: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `GET ${url} failed (${res.status})`);
  return res.json();
}

export const fetchWeeks = () => getJson<WeekRow[]>("/api/weeks");

export const fetchItems = (week: string, page: number, limit: number) =>
  getJson<ItemsPage>(`/api/items?week=${encodeURIComponent(week)}&page=${page}&limit=${limit}`);

/** One saved generation for a week. The server stores the whole draft array as a
 *  row's `output`, so a week can have several — newest first. */
export interface DraftRow {
  id: number;
  created_at: string;
  iso_week: string;
  drafts: Draft[];
}

// Every row is normalised on the way in — see `normalizeDrafts`. A draft stored
// before Markdown was the format arrives as `{ angle, text }`, and converting it
// here rather than at the point of display is what keeps a save containing one
// from being rejected wholesale.
export const fetchDrafts = async (week: string): Promise<DraftRow[]> => {
  const rows = await getJson<DraftRow[]>(`/api/drafts?week=${encodeURIComponent(week)}`);
  return rows.map((r) => ({ ...r, drafts: normalizeDrafts(r.drafts ?? []) }));
};

export interface CollectRun {
  id: number;
  status: "pending" | "running" | "done" | "error";
  source: "manual" | "daily";
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  inserted: number | null;
  error: string | null;
  /** Sessions summarized so far, out of progress_total. Null until the collector has counted. */
  progress_done: number | null;
  progress_total: number | null;
  /** The collector's own projection from its recent pace. */
  progress_eta_ms: number | null;
  heartbeat_at: string | null;
}

// Enqueue a collection run. 409 (single-flight) is not an error here — it means a
// run is already active; we return it so the caller can track that one instead.
export async function requestCollect(): Promise<{ run: CollectRun; alreadyActive: boolean }> {
  const res = await fetch("/api/collect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "manual" }),
  });
  if (res.status === 202 || res.status === 409) return res.json();
  throw new Error((await res.json().catch(() => ({}))).error ?? `collect failed (${res.status})`);
}

export const fetchCollectStatus = () => getJson<{ run: CollectRun | null }>("/api/collect/status");

// Mark an item ignored (excluded from draft generation) or restore it.
export async function setItemIgnored(id: number, ignored: boolean): Promise<{ id: number; ignored: boolean }> {
  const res = await fetch(`/api/items/${id}/ignore`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ignored }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `ignore failed (${res.status})`);
  return res.json();
}

// The server streams NDJSON: a `stage` event as each model pass starts, then one
// `result` or `error`. See /api/generate in server.ts.
export async function generate(
  week: string,
  manualText: string,
  onStage: (stage: GenerateStage) => void = () => {}
): Promise<{ draftId: number; drafts: Draft[] }> {
  const res = await fetch("/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ week, manualText }),
  });
  if (!res.ok || !res.body) {
    throw new Error((await res.json().catch(() => ({}))).error ?? `generate failed (${res.status})`);
  }
  const lines = createLineSplitter();
  const reader = res.body.getReader();
  let outcome: { draftId: number; drafts: Draft[] } | null = null;
  const handle = (line: string) => {
    const ev = JSON.parse(line);
    if (ev.type === "stage") onStage(ev.stage);
    else if (ev.type === "error") throw new Error(ev.error ?? "generation failed");
    else if (ev.type === "result") outcome = { draftId: ev.draftId, drafts: ev.drafts };
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      lines.push(value).forEach(handle);
    }
    lines.end().forEach(handle);
  } finally {
    // An error event or a bad line throws out of the loop with the body unread.
    reader.cancel().catch(() => {});
  }
  // A stream that ends with neither event is a connection dropped mid-generation —
  // a proxy timeout, say — not an empty result.
  if (!outcome) throw new Error("generation ended without a result — the connection was cut");
  return outcome;
}

// Persist in-place edits to a generated draft row. Only `md` is sent: the plain
// text a composer receives is derived from it on read, so there is nothing else
// about a draft that could be saved out of date.
export async function saveDrafts(draftId: number, drafts: Draft[]): Promise<void> {
  const res = await fetch(`/api/drafts/${draftId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ drafts }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `save failed (${res.status})`);
}
