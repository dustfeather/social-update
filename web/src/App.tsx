import { useEffect, useState } from "react";
import {
  fetchWeeks,
  fetchItems,
  generate,
  fetchGithubRepos,
  fetchSettings,
  saveSettings,
  type WeekRow,
  type Item,
  type Draft,
} from "./api";

const PAGE_SIZE = 25;

export default function App() {
  const [weeks, setWeeks] = useState<WeekRow[]>([]);
  const [week, setWeek] = useState<string>("");
  const [items, setItems] = useState<Item[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [manualText, setManualText] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load week list once; default to the newest week.
  useEffect(() => {
    fetchWeeks()
      .then((w) => {
        setWeeks(w);
        if (w.length) setWeek(w[0].week);
      })
      .catch((e) => setError(e.message));
  }, []);

  // Load items whenever the week or page changes.
  useEffect(() => {
    if (!week) return;
    fetchItems(week, page, PAGE_SIZE)
      .then((p) => {
        setItems(p.items);
        setTotal(p.total);
      })
      .catch((e) => setError(e.message));
  }, [week, page]);

  // Reset to page 1 and clear stale drafts when switching weeks.
  function selectWeek(w: string) {
    setWeek(w);
    setPage(1);
    setDrafts([]);
    setError(null);
  }

  async function onGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const res = await generate(week, manualText);
      setDrafts(res.drafts);
      if (res.drafts.length === 0) setError("Model returned no drafts — not enough material this week.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "generation failed");
    } finally {
      setGenerating(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="app">
      <header>
        <h1>Social Journal</h1>
        <label>
          Week{" "}
          <select value={week} onChange={(e) => selectWeek(e.target.value)}>
            {weeks.map((w) => (
              <option key={w.week} value={w.week}>
                {w.week} ({w.count})
              </option>
            ))}
          </select>
        </label>
      </header>

      {error && <div className="error">{error}</div>}

      <section className="items">
        <h2>
          Activity — {total} item{total === 1 ? "" : "s"}
        </h2>
        <ul>
          {items.map((it) => (
            <li key={it.id}>
              <span className={`tag tag-${it.source}`}>{it.source}</span>
              <span className="item-title">
                {it.url ? (
                  <a href={it.url} target="_blank" rel="noreferrer">
                    {it.title}
                  </a>
                ) : (
                  it.title
                )}
              </span>
              <span className="item-date">{it.occurred_at?.slice(0, 10)}</span>
            </li>
          ))}
        </ul>
        {totalPages > 1 && (
          <div className="pager">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              ‹ Prev
            </button>
            <span>
              Page {page} / {totalPages}
            </span>
            <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              Next ›
            </button>
          </div>
        )}
      </section>

      <section className="manual">
        <h2>Manual items</h2>
        <p className="hint">Work / NDA items the collectors can't see. Whole week is sent to generate.</p>
        <textarea
          value={manualText}
          onChange={(e) => setManualText(e.target.value)}
          placeholder="- Shipped X for client&#10;- Fixed Y in the deploy pipeline"
          rows={5}
        />
        <button className="generate" onClick={onGenerate} disabled={generating || !week}>
          {generating ? "Generating…" : "Generate drafts"}
        </button>
      </section>

      {drafts.length > 0 && (
        <section className="drafts">
          <h2>Drafts</h2>
          {drafts.map((d, i) => (
            <DraftCard key={i} draft={d} />
          ))}
        </section>
      )}

      <RepoSettings />
    </div>
  );
}

// Manage the GitHub repo exclusion list (persisted to .env, applied on next collection).
function RepoSettings() {
  const [repos, setRepos] = useState<string[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [pattern, setPattern] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([fetchGithubRepos(), fetchSettings()])
      .then(([r, s]) => {
        setRepos(r);
        setExcluded(new Set(s.excludeRepos));
      })
      .catch(() => setStatus("failed to load settings"));
  }, []);

  function toggle(name: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
    setStatus(null);
  }

  function addPattern() {
    const p = pattern.trim();
    if (!p) return;
    setExcluded((prev) => new Set(prev).add(p));
    setPattern("");
    setStatus(null);
  }

  async function save() {
    try {
      await saveSettings([...excluded]);
      setStatus("Saved — applies on the next collection run.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "save failed");
    }
  }

  // Excluded entries that aren't in the known repo list (e.g. "owner/*" patterns).
  const extraPatterns = [...excluded].filter((e) => !repos.includes(e));

  return (
    <details className="settings">
      <summary>GitHub repo filter</summary>
      <p className="hint">Checked repos are excluded from collection. Saved to .env; applied next run.</p>
      <ul className="repo-list">
        {repos.map((r) => (
          <li key={r}>
            <label>
              <input type="checkbox" checked={excluded.has(r)} onChange={() => toggle(r)} /> {r}
            </label>
          </li>
        ))}
        {repos.length === 0 && <li className="hint">No GitHub repos collected yet.</li>}
      </ul>

      {extraPatterns.length > 0 && (
        <div className="patterns">
          {extraPatterns.map((p) => (
            <span key={p} className="chip">
              {p} <button onClick={() => toggle(p)}>×</button>
            </span>
          ))}
        </div>
      )}

      <div className="pattern-add">
        <input
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          placeholder="owner/* or owner/repo"
          onKeyDown={(e) => e.key === "Enter" && addPattern()}
        />
        <button onClick={addPattern}>Add pattern</button>
      </div>

      <button className="generate" onClick={save}>
        Save filter
      </button>
      {status && <p className="hint">{status}</p>}
    </details>
  );
}

function DraftCard({ draft }: { draft: Draft }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(draft.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <article className="card">
      <div className="card-head">
        <span className="angle">{draft.angle}</span>
        <button onClick={copy}>{copied ? "Copied ✓" : "Copy"}</button>
      </div>
      <pre className="card-text">{draft.text}</pre>
    </article>
  );
}
