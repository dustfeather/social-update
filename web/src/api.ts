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

export async function generate(week: string, manualText: string): Promise<{ draftId: number; drafts: Draft[] }> {
  const res = await fetch("/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ week, manualText }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `generate failed (${res.status})`);
  return res.json();
}
