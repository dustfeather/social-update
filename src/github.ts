import { execFile } from "child_process";
import { promisify } from "util";
import { config } from "dotenv";
import { insertItems, type ItemInput } from "./db";

const execFileAsync = promisify(execFile);

config();

const GITHUB_USER = process.env.GITHUB_USER ?? "dustfeather";

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
      const msgs = commits.map((c) => `- ${String(c?.message ?? "").split("\n")[0]}`).join("\n");
      // The events feed often omits commit details, so n can be 0 — keep the title clean.
      const count = n > 0 ? `${n} commit${n === 1 ? "" : "s"}` : "commits";
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
  const events = await fetchEvents();
  const rows: ItemInput[] = [];
  for (const e of events) {
    if (!e.id) continue; // need a stable external_id
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
