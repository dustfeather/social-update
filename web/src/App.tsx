import { useEffect, useState } from "react";
import {
  fetchWeeks,
  fetchItems,
  generate,
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
    </div>
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
