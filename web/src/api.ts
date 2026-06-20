// Thin typed wrapper over the backend API.

export interface WeekRow {
  week: string;
  count: number;
}

export interface Item {
  id: number;
  source: string;
  title: string | null;
  body: string | null;
  url: string | null;
  occurred_at: string | null;
  iso_week: string | null;
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
  text: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `GET ${url} failed (${res.status})`);
  return res.json();
}

export const fetchWeeks = () => getJson<WeekRow[]>("/api/weeks");

export const fetchItems = (week: string, page: number, limit: number) =>
  getJson<ItemsPage>(`/api/items?week=${encodeURIComponent(week)}&page=${page}&limit=${limit}`);

export const fetchGithubRepos = () => getJson<string[]>("/api/github-repos");

export const fetchSettings = () => getJson<{ excludeRepos: string[] }>("/api/settings");

export async function saveSettings(excludeRepos: string[]): Promise<{ excludeRepos: string[] }> {
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ excludeRepos }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `save failed (${res.status})`);
  return res.json();
}

export interface CollectRun {
  id: number;
  status: "pending" | "running" | "done" | "error";
  source: "manual" | "daily";
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  inserted: number | null;
  error: string | null;
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

export async function generate(week: string, manualText: string): Promise<{ draftId: number; drafts: Draft[] }> {
  const res = await fetch("/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ week, manualText }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `generate failed (${res.status})`);
  return res.json();
}
