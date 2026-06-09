import { execFile } from "child_process";
import { promisify } from "util";
import { config } from "dotenv";
import { insertItems } from "./sink";
import type { ItemInput } from "./db";

const execFileAsync = promisify(execFile);

config();

const GITHUB_USER = process.env.GITHUB_USER ?? "dustfeather";

// Repos to drop from collection. Comma-separated "owner/repo"; a trailing "/*"
// matches a whole owner (e.g. "acme/*"). Matching is case-insensitive.
//
// Source of the list: in the k3s split the UI writes it to the server DB, so the
// collector reads it back via GET /api/settings (INGEST_URL). Pure-local, it comes
// from the GITHUB_EXCLUDE_REPOS env var.
async function getExcludeRepos(): Promise<string[]> {
  const url = process.env.INGEST_URL;
  if (url) {
    try {
      const res = await fetch(new URL("/api/settings", url));
      if (res.ok) {
        const j = (await res.json()) as { excludeRepos?: string[] };
        return (j.excludeRepos ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
      }
    } catch {
      // network/server hiccup — fall back to the env var below rather than fail collection
    }
  }
  return (process.env.GITHUB_EXCLUDE_REPOS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function isExcluded(repo: string | undefined, exclude: string[]): boolean {
  if (!repo) return false;
  const name = repo.toLowerCase();
  return exclude.some((pat) => {
    if (pat.endsWith("/*")) return name.startsWith(pat.slice(0, -1)); // owner/*
    return name === pat;
  });
}

// Minimal shape of a GitHub event from /users/:user/events. Parsed defensively —
// payloads vary by `type` and only a subset of fields is guaranteed present.
interface GithubEvent {
  id?: string;
  type?: string;
  created_at?: string;
  repo?: { name?: string };
  payload?: Record<string, unknown>;
}

const repoUrl = (repo?: string) => (repo ? `https://github.com/${repo}` : null);

// Turn one event into a human title + body + best-effort url. Returns null for
// unparseable events so the collector can skip them.
function summarize(e: GithubEvent): { title: string; body: string | null; url: string | null } | null {
  const repo = e.repo?.name;
  const p = (e.payload ?? {}) as any;
  const repoLabel = repo ?? "a repository";

  switch (e.type) {
    case "PushEvent": {
      const commits: any[] = Array.isArray(p.commits) ? p.commits : [];
      const branch = String(p.ref ?? "").replace(/^refs\/heads\//, "");
      const n = commits.length || (typeof p.size === "number" ? p.size : 0);
      // Zero-commit pushes (branch create/delete, force-push, no-op) carry no
      // content — skip them rather than emit a hollow "Pushed commits" item.
      if (n === 0) return null;
      const msgs = commits.map((c) => `- ${String(c?.message ?? "").split("\n")[0]}`).join("\n");
      const count = `${n} commit${n === 1 ? "" : "s"}`;
      return {
        title: `Pushed ${count} to ${repoLabel}${branch ? ` (${branch})` : ""}`,
        body: msgs || null,
        url: repoUrl(repo),
      };
    }
    case "CreateEvent": {
      const refType = p.ref_type ?? "ref";
      const ref = p.ref;
      const title =
        refType === "repository"
          ? `Created repository ${repoLabel}`
          : `Created ${refType} ${ref ?? ""} in ${repoLabel}`.trim();
      return { title, body: p.description ? String(p.description) : null, url: repoUrl(repo) };
    }
    case "PullRequestEvent": {
      const pr = p.pull_request ?? {};
      const action = p.action ?? "updated";
      return {
        title: `${capitalize(String(action))} pull request: ${pr.title ?? `#${p.number ?? ""}`} in ${repoLabel}`,
        body: pr.body ? String(pr.body) : null,
        url: pr.html_url ?? repoUrl(repo),
      };
    }
    case "ReleaseEvent": {
      const rel = p.release ?? {};
      return {
        title: `Released ${rel.name ?? rel.tag_name ?? ""} in ${repoLabel}`.trim(),
        body: rel.body ? String(rel.body) : null,
        url: rel.html_url ?? repoUrl(repo),
      };
    }
    case "IssuesEvent": {
      const issue = p.issue ?? {};
      return {
        title: `${capitalize(String(p.action ?? "updated"))} issue: ${issue.title ?? `#${issue.number ?? ""}`} in ${repoLabel}`,
        body: issue.body ? String(issue.body) : null,
        url: issue.html_url ?? repoUrl(repo),
      };
    }
    case "ForkEvent":
      return { title: `Forked ${repoLabel}`, body: null, url: repoUrl(repo) };
    case "WatchEvent":
      return { title: `Starred ${repoLabel}`, body: null, url: repoUrl(repo) };
    default:
      if (!e.type) return null;
      return {
        title: `${e.type.replace(/Event$/, "")} in ${repoLabel}`,
        body: null,
        url: repoUrl(repo),
      };
  }
}

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// Fetch all recent events via the authenticated gh CLI (includes private events).
async function fetchEvents(): Promise<GithubEvent[]> {
  const { stdout } = await execFileAsync(
    "gh",
    ["api", `/users/${GITHUB_USER}/events`, "--paginate"],
    { maxBuffer: 64 * 1024 * 1024 }
  );
  // With --paginate over an array endpoint, gh emits one merged JSON array.
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed : [];
}

export async function collectGithub(): Promise<number> {
  const [events, exclude] = await Promise.all([fetchEvents(), getExcludeRepos()]);
  const rows: ItemInput[] = [];
  for (const e of events) {
    if (!e.id) continue; // need a stable external_id
    if (isExcluded(e.repo?.name, exclude)) continue; // user-configured repo exclusions
    const s = summarize(e);
    if (!s) continue;
    rows.push({
      source: "github",
      external_id: e.id,
      title: s.title,
      body: s.body,
      url: s.url,
      occurred_at: e.created_at ?? null,
      raw_json: JSON.stringify(e),
    });
  }
  return insertItems(rows);
}
