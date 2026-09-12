import { useEffect, useRef, useState } from "react";
import { isoWeekRange } from "./iso-week";
import { htmlToText, textToHtml, firstUrl, sanitizeHtml, sanitizeElement, safeHref } from "./draft-text";
import {
  fetchWeeks,
  fetchItems,
  generate,
  requestCollect,
  fetchCollectStatus,
  setItemIgnored,
  saveDrafts,
  type WeekRow,
  type Item,
  type Draft,
  type CollectRun,
} from "./api";

const PAGE_SIZE = 25;

// tags is a JSON array written by the collection run's tagging pass, NULL until a
// run has tagged that item. Malformed content is treated as untagged rather than
// crashing the list — a bad row must not take the page down with it.
function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

// The expanded record behind one activity row. Everything shown here already
// arrived with the list, so this is pure presentation — no fetch, no loading state.
// The body is plain text written by the summarizer (a paragraph, then highlight
// bullets), so it renders pre-wrapped rather than as markup.
function ItemDetail({ item }: { item: Item }) {
  // A stored url is collector-written, not user-typed, but it still reaches an
  // href — and a `javascript:` there is script execution one click later. Refused
  // schemes stay visible as text so the record is still complete, just not armed.
  const href = item.url ? safeHref(item.url) : null;
  return (
    <div className="item-detail">
      {item.body ? (
        <p className="item-body">{item.body}</p>
      ) : (
        <p className="item-body item-body-empty">No summary stored for this item.</p>
      )}
      <dl className="item-meta">
        <dt>Source</dt>
        <dd>{item.source}</dd>
        {item.external_id && (
          <>
            <dt>Session</dt>
            <dd className="item-id">{item.external_id}</dd>
          </>
        )}
        {item.occurred_at && (
          <>
            <dt>Occurred</dt>
            <dd>{item.occurred_at.replace("T", " ").slice(0, 16)}</dd>
          </>
        )}
        {item.collected_at && (
          <>
            <dt>Collected</dt>
            <dd>{item.collected_at.replace("T", " ").slice(0, 16)}</dd>
          </>
        )}
        {item.url && (
          <>
            <dt>Link</dt>
            <dd>
              {href ? (
                <a href={href} target="_blank" rel="noreferrer">
                  {item.url}
                </a>
              ) : (
                <span className="item-url-refused" title="Refused: not an http(s) or mailto URL">
                  {item.url}
                </span>
              )}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

export default function App() {
  const [weeks, setWeeks] = useState<WeekRow[]>([]);
  const [week, setWeek] = useState<string>("");
  const [items, setItems] = useState<Item[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  // Which item's full summary is expanded. The list already carries every field
  // /api/items returns, so opening one costs no extra request.
  const [openId, setOpenId] = useState<number | null>(null);
  const [manualText, setManualText] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [draftId, setDraftId] = useState<number | null>(null); // row the edits save back onto
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
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
        setOpenId(null); // the open row is gone once the list underneath changes
      })
      .catch((e) => setError(e.message));
  }, [week, page]);

  // Reset to page 1 and clear stale drafts when switching weeks.
  function selectWeek(w: string) {
    setWeek(w);
    setPage(1);
    setDrafts([]);
    setDraftId(null);
    setSaveState("idle");
    setError(null);
  }

  async function onGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const res = await generate(week, manualText);
      setDrafts(res.drafts);
      setDraftId(res.draftId);
      setSaveState("idle");
      if (res.drafts.length === 0) setError("Model returned no drafts — not enough material this week.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "generation failed");
    } finally {
      setGenerating(false);
    }
  }

  // Toggle an item's ignored flag (optimistic; reverts on failure). Ignored items
  // stay listed but are excluded from draft generation.
  async function toggleIgnore(it: Item) {
    const next = it.ignored ? 0 : 1;
    setItems((prev) => prev.map((p) => (p.id === it.id ? { ...p, ignored: next } : p)));
    try {
      await setItemIgnored(it.id, next === 1);
    } catch (e) {
      setItems((prev) => prev.map((p) => (p.id === it.id ? { ...p, ignored: it.ignored } : p)));
      setError(e instanceof Error ? e.message : "ignore failed");
    }
  }

  // Edits are debounced back onto the draft row: the editor fires on every
  // keystroke, and a PUT per character would be absurd. The timer is keyed to
  // the whole array so a change to any card restarts the same 800ms window.
  const pendingSave = useRef<ReturnType<typeof setTimeout> | null>(null);
  function editDraft(index: number, next: Draft) {
    setDrafts((prev) => {
      const copy = prev.map((d, i) => (i === index ? next : d));
      if (draftId !== null) {
        if (pendingSave.current) clearTimeout(pendingSave.current);
        setSaveState("saving");
        pendingSave.current = setTimeout(() => {
          saveDrafts(draftId, copy)
            .then(() => setSaveState("saved"))
            .catch(() => setSaveState("error"));
        }, 800);
      }
      return copy;
    });
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const weekRange = isoWeekRange(week);

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
        <CollectButton />
      </header>

      {error && <div className="error">{error}</div>}

      <section className="items">
        <h2>
          Activity — {total} item{total === 1 ? "" : "s"}
          {weekRange && <span className="h2-range"> ({weekRange})</span>}
        </h2>
        <ul>
          {items.map((it) => (
            <li key={it.id} className={it.ignored ? "item-ignored" : undefined}>
              <span className={`tag tag-${it.source}`}>{it.source}</span>
              <span className="item-title">
                <button
                  className="item-open"
                  aria-expanded={openId === it.id}
                  onClick={() => setOpenId((cur) => (cur === it.id ? null : it.id))}
                  title="Show the full summary"
                >
                  {it.title}
                </button>
                {parseTags(it.tags).map((t) => (
                  <span key={t} className="item-tag">
                    {t}
                  </span>
                ))}
              </span>
              <span className="item-date">{it.occurred_at?.slice(0, 10)}</span>
              <button
                className="item-ignore"
                onClick={() => toggleIgnore(it)}
                title={it.ignored ? "Restore — include in drafts" : "Ignore — exclude from drafts"}
              >
                {it.ignored ? "Restore" : "Ignore"}
              </button>
              {openId === it.id && <ItemDetail item={it} />}
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
          <h2>
            Drafts
            {saveState !== "idle" && (
              <span className={`save-state save-${saveState}`}>
                {saveState === "saving" ? "saving…" : saveState === "saved" ? "saved ✓" : "save failed"}
              </span>
            )}
          </h2>
          <p className="hint">
            Editable — format the text and add links, then share. Edits save automatically.
          </p>
          {drafts.map((d, i) => (
            <DraftCard key={i} draft={d} onChange={(next) => editDraft(i, next)} />
          ))}
        </section>
      )}

    </div>
  );
}

// "Collect now" — enqueues a run on the server; the local poller on the WSL box
// picks it up and runs the collectors. Polls the run's status and pops a
// completion notification when the run we triggered finishes.
function CollectButton() {
  const [run, setRun] = useState<CollectRun | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const trackedId = useRef<number | null>(null); // run we're watching to completion
  const notifiedId = useRef<number | null>(null); // last run we've notified about

  const active = run?.status === "pending" || run?.status === "running";

  // Poll the latest run: fast (5s) while one is active or we're tracking a click,
  // slow (30s) otherwise just to keep the button state honest across timer runs.
  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const { run: latest } = await fetchCollectStatus();
        if (!alive) return;
        setRun(latest);
        if (
          latest &&
          latest.id === trackedId.current &&
          (latest.status === "done" || latest.status === "error") &&
          notifiedId.current !== latest.id
        ) {
          notifiedId.current = latest.id;
          trackedId.current = null;
          setNotice(
            latest.status === "done"
              ? `Collection finished — ${latest.inserted ?? 0} new item${latest.inserted === 1 ? "" : "s"}.`
              : `Collection failed — ${latest.error ?? "unknown error"}`
          );
        }
      } catch {
        /* transient — next tick retries */
      }
    }
    tick();
    const fast = active || trackedId.current != null;
    const id = setInterval(tick, fast ? 5000 : 30000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [active]);

  async function onClick() {
    setNotice(null);
    try {
      const { run: r } = await requestCollect();
      notifiedId.current = null;
      trackedId.current = r.id; // also covers the 409 "already active" run
      setRun(r); // pending/running → flips polling to fast
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "collect failed");
    }
  }

  return (
    <span className="collect">
      <button className="collect-btn" onClick={onClick} disabled={active}>
        {active ? "Collecting…" : "Collect now"}
      </button>
      {notice && (
        <span className="collect-notice">
          {notice} <button className="collect-dismiss" onClick={() => setNotice(null)}>×</button>
        </span>
      )}
    </span>
  );
}

// --- Draft editing -----------------------------------------------------------

const X_LIMIT = 280;

// Only X still reliably honours a prefilled body. LinkedIn's shareActive composer
// usually does; Facebook's sharer dropped `quote` and takes a URL only. So every
// share copies the text to the clipboard first — the tab that opens may come up
// empty, and pasting is then one keystroke rather than a lost draft.
const SHARES: Array<{ key: string; label: string; href: (text: string) => string }> = [
  {
    key: "x",
    label: "X",
    href: (t) => `https://twitter.com/intent/tweet?text=${encodeURIComponent(t)}`,
  },
  {
    key: "linkedin",
    label: "LinkedIn",
    href: (t) => `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(t)}`,
  },
  {
    key: "facebook",
    label: "Facebook",
    href: (t) => {
      const u = firstUrl(t);
      return u
        ? `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(u)}`
        : "https://www.facebook.com/";
    },
  },
];

function DraftCard({ draft, onChange }: { draft: Draft; onChange: (next: Draft) => void }) {
  const [copied, setCopied] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const editor = useRef<HTMLDivElement | null>(null);
  const savedRange = useRef<Range | null>(null);

  // The editor is UNCONTROLLED on purpose: re-rendering a contenteditable from
  // React state on every keystroke resets the caret to the start. Seed it once,
  // then read back out of the DOM.
  // Sanitized on the way in: this string is handed to dangerouslySetInnerHTML,
  // and draft.html has been round-tripped through the API and the DB since it
  // was last in a trusted DOM.
  const initialHtml = useRef(sanitizeHtml(draft.html ?? textToHtml(draft.text)));

  function syncFromEditor() {
    const el = editor.current;
    if (!el) return;
    // Store the sanitized serialization, not raw innerHTML: a paste of rich
    // content can drop arbitrary markup into a contenteditable. The live DOM is
    // left alone so the caret doesn't move.
    onChange({ ...draft, html: sanitizeElement(el), text: htmlToText(el) });
  }

  // execCommand is deprecated but remains the only zero-dependency way to get
  // bold/italic/lists/links inside contenteditable, and every current browser
  // still implements it. Focus first so the command has a selection to act on.
  function exec(command: string, value?: string) {
    editor.current?.focus();
    document.execCommand(command, false, value);
    syncFromEditor();
  }

  // Opening the link box moves focus out of the editor, which drops the
  // selection — stash the range first and restore it on apply.
  function openLink() {
    const sel = window.getSelection();
    savedRange.current = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const selected = savedRange.current?.toString() ?? "";
    setLinkUrl(/^https?:\/\//.test(selected) ? selected : "");
    setLinkOpen(true);
  }

  function applyLink() {
    const url = linkUrl.trim();
    if (!url) {
      setLinkOpen(false);
      return;
    }
    // A bare domain gets https://; a javascript:/data: URL is refused outright
    // (an allowlisted <a> with a script URL is still script execution).
    const href = safeHref(url);
    if (!href) {
      setLinkOpen(false);
      return;
    }
    const el = editor.current;
    const range = savedRange.current;
    if (el && range) {
      el.focus();
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      if (range.collapsed) {
        // Nothing was selected. createLink would be a no-op on a collapsed
        // range, so insert the URL as text and select it back.
        document.execCommand("insertText", false, href);
        const after = window.getSelection();
        const node = after?.anchorNode;
        if (after && node) {
          const r = document.createRange();
          r.setStart(node, Math.max(0, after.anchorOffset - href.length));
          r.setEnd(node, after.anchorOffset);
          after.removeAllRanges();
          after.addRange(r);
        }
      }
      document.execCommand("createLink", false, href);
      // execCommand can't set attributes, so open links in a new tab ourselves.
      el.querySelectorAll("a").forEach((a) => {
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noreferrer");
      });
      syncFromEditor();
    }
    setLinkOpen(false);
    setLinkUrl("");
  }

  // Copy both flavours: HTML for editors that accept it, plain text for the
  // social composers that don't.
  async function copy() {
    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([draft.html ?? textToHtml(draft.text)], { type: "text/html" }),
            "text/plain": new Blob([draft.text], { type: "text/plain" }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(draft.text);
      }
    } catch {
      await navigator.clipboard.writeText(draft.text);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function share(href: string) {
    // Open the composer INSIDE the click's user activation. Awaiting the
    // clipboard first spends the gesture — the tab then gets popup-blocked —
    // and an unfocused document can leave writeText pending forever, which
    // looks like a dead button. Copy afterwards, best-effort.
    window.open(href, "_blank", "noopener,noreferrer");
    navigator.clipboard.writeText(draft.text).catch(() => {});
  }

  const chars = draft.text.length;

  return (
    <article className="card">
      <div className="card-head">
        <span className="angle">{draft.angle}</span>
        <span className={`count${chars > X_LIMIT ? " count-over" : ""}`}>{chars} chars</span>
        <button onClick={copy}>{copied ? "Copied ✓" : "Copy"}</button>
      </div>

      <div className="toolbar">
        {/* onMouseDown+preventDefault keeps the editor's selection alive: a plain
            click blurs the editor before the command can run. */}
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => exec("bold")} title="Bold">
          <b>B</b>
        </button>
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => exec("italic")} title="Italic">
          <i>I</i>
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => exec("insertUnorderedList")}
          title="Bulleted list"
        >
          • List
        </button>
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={openLink} title="Add link">
          🔗 Link
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => exec("removeFormat")}
          title="Clear formatting"
        >
          Clear
        </button>
      </div>

      {linkOpen && (
        <div className="linkbar">
          <input
            autoFocus
            value={linkUrl}
            placeholder="https://example.com"
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              // preventDefault matters: applyLink() puts focus and the saved
              // selection back INSIDE the editor, so an un-prevented Enter lands
              // there as a line break and replaces the very text being linked.
              if (e.key === "Enter") {
                e.preventDefault();
                applyLink();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setLinkOpen(false);
              }
            }}
          />
          <button onClick={applyLink}>Apply</button>
          <button onClick={() => setLinkOpen(false)}>Cancel</button>
        </div>
      )}

      <div
        className="card-text editor"
        ref={editor}
        contentEditable
        suppressContentEditableWarning
        onInput={syncFromEditor}
        onBlur={syncFromEditor}
        dangerouslySetInnerHTML={{ __html: initialHtml.current }}
      />

      <div className="share">
        <span className="share-label">Share</span>
        {SHARES.map((s) => (
          <button
            key={s.key}
            className={`share-btn share-${s.key}`}
            onClick={() => share(s.href(draft.text))}
            title={
              s.key === "x" && chars > X_LIMIT
                ? `${chars} characters — X will cut this at ${X_LIMIT}`
                : `Copy the text and open ${s.label}`
            }
          >
            {s.label}
          </button>
        ))}
        <span className="hint share-hint">
          Text is copied to your clipboard first — Facebook (and sometimes LinkedIn) won't prefill
          it, so paste into the composer.
        </span>
      </div>
    </article>
  );
}
