import { useEffect, useMemo, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { isoWeekRange } from "./iso-week";
import {
  flattenMd,
  firstUrl,
  draftMd,
  safeHref,
  countGraphemes,
  countForX,
  isHostname,
  residualMarkers,
  shareState,
  lastSelectedLine,
  wrapEdit,
} from "./draft-text";
import { tags } from "@lezer/highlight";
import {
  fetchWeeks,
  fetchItems,
  fetchDrafts,
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
      {/* Source, session id and the two timestamps used to sit here. They are
          provenance, not content: the same four values on every row of a list that
          is already grouped by week, pushing the summary — the only thing anyone
          reads — above the fold. They are still on the item and still in the DB;
          the API returns them and `GET /api/items` is how you look one up. */}
      {item.url && (
        <dl className="item-meta">
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
        </dl>
      )}
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
  // One instance for the week, not one per card. This was DraftCard state seeded
  // from localStorage at mount, so saving it on card 1 left cards 2 and 3 holding
  // the empty string they mounted with: the prompt reopened on the next card and
  // the `{instance} ✎` chip appeared on one card only, which is not "asks once and
  // remembers it". It describes the USER, not the draft, so it lives with the user.
  const [instance, setInstance] = useState(readInstance);
  const rememberInstance = (h: string) => {
    setInstance(h);
    try {
      localStorage.setItem(MASTODON_KEY, h);
    } catch {
      /* not remembering it costs one retype, not the share */
    }
  };
  const [manualText, setManualText] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [draftId, setDraftId] = useState<number | null>(null); // row the edits save back onto
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
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

  // Load the week's saved drafts. Generating writes a row and every edit is
  // PUT back onto it, but nothing read them again — so a reload, or coming back
  // to the week later, showed no editor at all and the work looked lost. Only
  // the newest row is opened: a regenerate inserts a new one rather than
  // overwriting, so the older rows are previous generations, not edits.
  useEffect(() => {
    if (!week) return;
    let current = true;
    fetchDrafts(week)
      .then((rows) => {
        if (!current) return; // a faster week switch already won
        const newest = rows[0];
        setDrafts(newest?.drafts ?? []);
        setDraftId(newest?.id ?? null);
        setSaveState("idle");
      })
      .catch((e) => setError(e.message));
    return () => {
      current = false;
    };
  }, [week]);

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
  const latest = useRef<Draft[]>([]);
  function editDraft(index: number, next: Draft) {
    // The updater is PURE. It used to schedule the save and call setSaveState
    // from inside here, which React is free to run twice (StrictMode) or during
    // another component's render: that double-schedules the debounce and makes
    // the state update a setState-during-render, on the one path that runs for
    // every single keystroke in the editor.
    setDrafts((prev) => {
      const copy = prev.map((d, i) => (i === index ? next : d));
      latest.current = copy;
      return copy;
    });
    if (draftId === null) return;
    if (pendingSave.current) clearTimeout(pendingSave.current);
    setSaveState("saving");
    pendingSave.current = setTimeout(() => {
      // latest.current, not a copy captured here: the timer fires once for a
      // burst of keystrokes and must save the last of them, not the first.
      saveDrafts(draftId, latest.current)
        .then(() => {
          setSaveState("saved");
          setSaveError(null);
        })
        // The message was being discarded, so a 400 from the stricter PUT
        // validation looked exactly like the wifi dropping. They need opposite
        // responses from the author, and only one of them is worth retrying.
        .catch((e) => {
          setSaveState("error");
          setSaveError(e instanceof Error ? e.message : "save failed");
        });
    }, 800);
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
                {saveState === "saving" ? "saving…" : saveState === "saved" ? "saved ✓" : (saveError ?? "save failed")}
              </span>
            )}
          </h2>
          <p className="hint">
            Editable — format the text and add links, then share. Edits save automatically.
          </p>
          {/* Keyed by the row, not just the index: the editor seeds itself from its
              draft ONCE per mount, so a bare index lets React reuse card 0 of the
              previous week — or of the generation before a regenerate — and the
              editor keeps showing the draft it was first mounted with. */}
          {drafts.map((d, i) => (
            <DraftCard
              key={`${draftId}-${i}`}
              draft={d}
              onChange={(next) => editDraft(i, next)}
              instance={instance}
              onInstance={rememberInstance}
            />
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

// Per-network hard limits, in characters of the FLATTENED text — which is what
// each of these composers actually counts. Until now only X had a number here and
// it was cosmetic: a tooltip warned and the button stayed live, so the one
// network that truncates was also the one you could still fire a too-long post at.
//
// Facebook's is its post limit rather than a sharer limit; it takes a URL only
// (see below), so nothing long ever reaches it.
const SHARES: Array<{
  key: string;
  label: string;
  limit: number;
  /** Facebook's sharer dropped `quote` and accepts a link and nothing else, so a
   *  draft with no URL in it has nothing to send. */
  urlOnly?: boolean;
  /** Mastodon has no single host to post to — the share URL is per instance. */
  needsInstance?: boolean;
  /** How THIS network measures the post. Defaults to graphemes; X substitutes URLs. */
  count?: (text: string) => number;
  /** A limit we cannot actually know for this user's server: warn, never disable. */
  soft?: boolean;
  href: (text: string, instance: string, url: string | null) => string;
}> = [
  {
    key: "x",
    label: "X",
    limit: 280,
    count: countForX,
    href: (t) => `https://twitter.com/intent/tweet?text=${encodeURIComponent(t)}`,
  },
  {
    key: "linkedin",
    label: "LinkedIn",
    limit: 3000,
    href: (t) => `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(t)}`,
  },
  {
    key: "bluesky",
    label: "Bluesky",
    limit: 300,
    href: (t) => `https://bsky.app/intent/compose?text=${encodeURIComponent(t)}`,
  },
  {
    key: "threads",
    label: "Threads",
    limit: 500,
    href: (t) => `https://www.threads.net/intent/post?text=${encodeURIComponent(t)}`,
  },
  {
    key: "mastodon",
    label: "Mastodon",
    // 500 is only Mastodon's DEFAULT max_toot_chars. Instances raise it freely (5000
    // is common) and advertise their own value, so a hard block here refuses posts the
    // user's own server would take. Warn instead — we know the instance but not its
    // limit, and guessing low costs more than guessing high.
    limit: 500,
    soft: true,
    needsInstance: true,
    href: (t, instance) => `https://${instance}/share?text=${encodeURIComponent(t)}`,
  },
  {
    key: "facebook",
    label: "Facebook",
    limit: 63206,
    urlOnly: true,
    href: (_t, _instance, url) => {
      // Never the bare `https://www.facebook.com/` this used to fall through to.
      // The button is disabled when there is no URL, so this branch is only
      // reachable if that check and this one ever disagree — and dropping the
      // user on a logged-in feed with their draft silently gone is worse than
      // doing nothing at all. They now cannot: this takes the same `postUrl` the
      // disabled check reads, instead of scanning for a url of its own.
      return url ? `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}` : "";
    },
  },
];

// Remembered so the instance is asked for once rather than on every share. It is
// a hostname the user typed about themselves, not a credential.
const MASTODON_KEY = "social-update.mastodon-instance";
const readInstance = () => {
  try {
    // Validated on the way OUT as well as in. The version of this that shipped
    // before the draft/Save split wrote on every keystroke, so half-typed values
    // are already persisted in real browsers — and this value is interpolated
    // into a share URL, where a stored `good.social/x?q=` would build
    // `https://good.social/x?q=/share?text=<draft>` and send the post somewhere
    // the author never chose. An unusable value reads as absent, which reopens
    // the prompt.
    const v = localStorage.getItem(MASTODON_KEY) ?? "";
    return isHostname(v) ? v : "";
  } catch {
    return ""; // storage can be denied outright; a share still works, it just asks again
  }
};

// A Markdown transform on the current selection, applied as a CodeMirror
// transaction so it lands in the undo history like typing does. This is what
// replaced the execCommand toolbar: execCommand could not set attributes, had no
// defined behaviour across browsers, and is deprecated with no replacement —
// whereas "put these characters around the selection" is just an edit.
function wrap(view: EditorView, before: string, after = before) {
  const { from, to } = view.state.selection.main;
  // The decision — insert the markers, or take an existing pair back off — is
  // wrapEdit's, and is tested there. What is left here is the dispatch. The
  // selection it returns holds the words, not the markers: the next transform
  // should act on the same text, and an empty selection lands the caret between
  // the markers ready to type.
  const { from: start, to: end, insert, anchor, head } = wrapEdit(view.state.doc.toString(), from, to, before, after);
  view.dispatch({
    changes: { from: start, to: end, insert },
    selection: { anchor, head },
    scrollIntoView: true,
  });
  view.focus();
}

// Prefix every line the selection touches. `- ` and `1. ` are line constructs, so
// wrapping the selection would produce `- one\ntwo` rather than two list items.
function prefixLines(view: EditorView, prefix: (i: number) => string) {
  const { from, to } = view.state.selection.main;
  const first = view.state.doc.lineAt(from).number;
  const last = lastSelectedLine(from, to, view.state.doc.lineAt(to));
  const changes = [];
  // `i` advances only where a prefix is actually inserted. Incrementing it in the
  // for-update ran on `continue` too, so a skipped blank line burned a number and
  // `one / blank / two` numbered 1, 3. The bullet case ignores `i` either way.
  for (let n = first, i = 0; n <= last; n++) {
    const line = view.state.doc.line(n);
    if (!line.text.trim() && first !== last) continue; // don't bullet the blank lines in a block
    changes.push({ from: line.from, insert: prefix(i++) });
  }
  view.dispatch({ changes, scrollIntoView: true });
  view.focus();
}

// The editor is dark-only (--bg #0f1115), and @codemirror/language's
// defaultHighlightStyle is built for a light background: in it tags.url, tags.labelName and
// tags.contentSeparator are #219, which lands at roughly 1.4:1 on this background. That is
// the URL inside [label](url) — the exact text the Link button inserts — rendered
// effectively invisible. These colours come from the app's own palette instead.
const mdHighlight = HighlightStyle.define([
  { tag: tags.heading, color: "#e6e8ec", fontWeight: "600" },
  { tag: tags.strong, color: "#e6e8ec", fontWeight: "700" },
  { tag: tags.emphasis, color: "#e6e8ec", fontStyle: "italic" },
  { tag: tags.strikethrough, color: "#8b90a0", textDecoration: "line-through" },
  { tag: [tags.link, tags.labelName], color: "#7aa2f7" },
  { tag: tags.url, color: "#7aa2f7", textDecoration: "underline" },
  { tag: [tags.monospace, tags.string], color: "#9ece6a" },
  { tag: [tags.list, tags.quote], color: "#8b90a0" },
  { tag: tags.contentSeparator, color: "#8b90a0" },
  { tag: [tags.processingInstruction, tags.meta], color: "#6b7080" },
]);

function DraftCard({
  draft,
  onChange,
  instance,
  onInstance,
}: {
  draft: Draft;
  onChange: (next: Draft) => void;
  instance: string;
  onInstance: (host: string) => void;
}) {
  const [copied, setCopied] = useState<{ what: "post" | "md"; failed: boolean } | null>(null);
  const [shared, setShared] = useState<{ key: string; copyFailed: boolean } | null>(null);
  const [instanceOpen, setInstanceOpen] = useState(false);
  const pendingShare = useRef<string | null>(null);
  // The input edits a DRAFT, never the committed value. Binding it straight to
  // `instance` meant every keystroke was live: typing "mastodon.soc" and pressing
  // Cancel left that as the instance, and because it is non-empty the prompt never
  // reopened — the next Mastodon share went to a host that does not resolve.
  const [instanceDraft, setInstanceDraft] = useState("");
  const [instanceError, setInstanceError] = useState<string | null>(null);
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);

  // `draftMd` is what makes a row written before Markdown existed open cleanly:
  // plain text is valid Markdown, and the old `text` already spelled links out.
  const md = draftMd(draft);

  // The editor is uncontrolled, for the same reason the contenteditable before it
  // was: re-creating its content from React state on every keystroke would move
  // the caret. CodeMirror owns the document; React is told about changes, and only
  // pushes one back when the value arrives from somewhere else (a regenerate).
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const angleRef = useRef(draft.angle);
  angleRef.current = draft.angle;

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: md,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown(),
          syntaxHighlighting(mdHighlight, { fallback: true }),
          EditorView.lineWrapping,
          // `.cm-content` is a contenteditable with role="textbox", so without
          // this it is announced as an unnamed text box — and it is the main
          // editing surface of the card, next to a preview that does have a name.
          EditorView.contentAttributes.of({ "aria-label": "Draft Markdown" }),
          EditorView.updateListener.of((u) => {
            // `docChanged` only: a selection move is not an edit, and saving on
            // one would mark the week dirty every time the caret moved.
            if (u.docChanged) onChangeRef.current({ angle: angleRef.current, md: u.state.doc.toString() });
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // Mount only. `md` is read once as the seed; see the effect below for updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // An external change — a regenerate replacing this card's draft — has to reach
  // the editor, but re-applying our OWN edit would reset the caret to the start
  // on every keystroke. Comparing against the live document distinguishes them:
  // after our own update listener fires, the two already agree.
  useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === md) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: md } });
  }, [md]);

  // The bytes a composer actually receives. Derived, never stored — see
  // draft-text.ts. Memoised because the counter reads it on every keystroke.
  const text = useMemo(() => flattenMd(md), [md]);
  // The generic count, shown in the header. Per-network counts are computed below,
  // because the networks disagree about what a character is.
  const chars = useMemo(() => countGraphemes(text), [text]);
  // Markers that outlived flattening — an unclosed bold run reaches the composer
  // as literal asterisks. Shown, never repaired, and computed from the SOURCE so
  // code spans are not mistaken for strays: see residualMarkers.
  const strays = useMemo(() => residualMarkers(md), [md]);
  // From the SOURCE, like `strays` above: a url inside a fence is code being quoted,
  // and flattening has already put it back verbatim by the time `text` exists.
  const postUrl = useMemo(() => firstUrl(md), [md]);

  function flash<T>(set: (v: T | null) => void, value: T) {
    set(value);
    setTimeout(() => set(null), 1500);
  }

  async function copy(what: "post" | "md") {
    // One flavour per button rather than a multi-format ClipboardItem. The
    // clipboard's custom-type support would need a `web text/markdown` prefix and
    // is refused outright in some browsers, so a single explicit choice is both
    // more portable and clearer about which of the two you are pasting.
    try {
      await navigator.clipboard.writeText(what === "post" ? text : md);
      flash(setCopied, { what, failed: false });
    } catch {
      // Say so. A swallowed rejection here is indistinguishable from a click that did
      // nothing, and the user's next move is to paste — getting whatever was on the
      // clipboard before. The text is still on screen, so nothing is lost, but only if
      // they know to select it.
      flash(setCopied, { what, failed: true });
    }
  }

  // `instanceOverride` beats the state value: saveInstance resumes the share that opened the
  // prompt, and it runs before React has re-rendered with the new instance.
  function share(s: (typeof SHARES)[number], instanceOverride?: string) {
    const useInstance = instanceOverride ?? instance;
    if (s.needsInstance && !useInstance) {
      openInstancePrompt(s.key); // resume this one once the instance is known
      return;
    }
    const href = s.href(text, useInstance, postUrl);
    if (!href) return;
    // Open the composer INSIDE the click's user activation. Awaiting the
    // clipboard first spends the gesture — the tab is then popup-blocked — and an
    // unfocused document can leave writeText pending forever, which looks like a
    // dead button. Copy afterwards, best-effort.
    window.open(href, "_blank", "noopener,noreferrer");
    // "Opened" is the only claim that can be made synchronously, and it is true:
    // the composer window opened. The copy is asynchronous and best-effort, so it
    // reports separately rather than being folded into this flash — the button used
    // to say "Opened ✓" beside a hint promising the post was on the clipboard, while
    // a rejected write was swallowed. On the targets that do not prefill (Facebook
    // gets a bare URL, LinkedIn often comes up empty) the user follows that hint and
    // pastes whatever was on the clipboard before.
    flash(setShared, { key: s.key, copyFailed: false });
    navigator.clipboard.writeText(text).catch(() => {
      // Only a REJECTED write flips this, never a pending one: an unfocused document
      // can leave writeText pending forever, so waiting for it before showing anything
      // is what makes the button look dead.
      setShared((cur) => (cur && cur.key === s.key ? { ...cur, copyFailed: true } : cur));
    });
  }

  // Opening always seeds the draft from the committed value, so editing an existing
  // instance starts from what is actually in use rather than from blank.
  function openInstancePrompt(forShare?: string) {
    setInstanceDraft(instance);
    setInstanceError(null);
    pendingShare.current = forShare ?? null;
    setInstanceOpen(true);
  }

  function saveInstance() {
    const h = instanceDraft.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!isHostname(h)) {
      // Refuse in place instead of closing: an empty host would build https:///share,
      // and a malformed one opens a tab on a name that cannot resolve, with the draft
      // gone. Neither failure tells the user what went wrong, so this one does.
      setInstanceError(h ? `"${h}" is not a hostname — try mastodon.social` : "Enter your instance's hostname");
      return;
    }
    onInstance(h);
    setInstanceOpen(false);
    setInstanceError(null);
    // Resume the share this prompt interrupted, rather than making the user click the
    // same button again — the first Mastodon share always cost two clicks. This runs
    // inside the Save button's own click, so window.open still has user activation.
    const pending = pendingShare.current;
    pendingShare.current = null;
    if (pending) {
      const s = SHARES.find((x) => x.key === pending);
      if (s) share(s, h);
    }
  }

  // Cancel throws the draft away. The committed instance is untouched, which is the
  // whole point of keeping them apart.
  function cancelInstance() {
    setInstanceOpen(false);
    setInstanceError(null);
    setInstanceDraft(instance);
    pendingShare.current = null;
  }


  return (
    <article className="card">
      <div className="card-head">
        <span className="angle">{draft.angle}</span>
        <span className="count">{chars} chars</span>
        {strays.length > 0 && (
          <span
            className="stray-markers"
            title={`${strays.join(" and ")} is not consumed by the formatting — an emphasis run that never closes in its paragraph, or an empty pair like ****, so it reaches the post as literal characters. Close it, fill it, delete it, or escape it if you meant it literally.`}
          >
            {strays.join(" ")} literal
          </span>
        )}
        <button onClick={() => copy("post")} title="Copy the post as plain text, ready to paste">
          {copied?.what === "post" ? (copied.failed ? "Copy failed" : "Copied ✓") : "Copy post"}
        </button>
        <button onClick={() => copy("md")} title="Copy the Markdown source">
          {copied?.what === "md" ? (copied.failed ? "Copy failed" : "Copied ✓") : "Copy Markdown"}
        </button>
      </div>

      <div className="toolbar">
        {/* These edit Markdown rather than calling execCommand, so every one of
            them is an ordinary edit: undo, redo and the caret all behave. The
            emphasis buttons toggle — pressing Bold on bold text takes the markers
            off again, which is what execCommand did and what a B button means. */}
        <button type="button" onClick={() => view.current && wrap(view.current, "**")} title="Bold">
          <b>B</b>
        </button>
        <button type="button" onClick={() => view.current && wrap(view.current, "*")} title="Italic">
          <i>I</i>
        </button>
        <button type="button" onClick={() => view.current && wrap(view.current, "`")} title="Code">
          {"<>"}
        </button>
        <button type="button" onClick={() => view.current && prefixLines(view.current, () => "- ")} title="Bulleted list">
          • List
        </button>
        <button
          type="button"
          onClick={() => view.current && prefixLines(view.current, (i) => `${i + 1}. `)}
          title="Numbered list"
        >
          1. List
        </button>
        <button type="button" onClick={() => view.current && wrap(view.current, "[", "](https://)")} title="Link">
          🔗 Link
        </button>
      </div>

      <div className="editor-split">
        <div className="editor-md" ref={host} />
        {/* What the composer gets, character for character. Rendered as text in a
            <pre>, never as HTML — which is why this file no longer needs a
            sanitizer: there is no longer anywhere to inject into. */}
        <pre className="preview" aria-label="Plain text preview">
          {text}
        </pre>
      </div>

      {instanceOpen && (
        <div className="linkbar">
          <input
            autoFocus
            value={instanceDraft}
            placeholder="mastodon.social"
            aria-label="Your Mastodon instance hostname"
            aria-invalid={instanceError ? true : undefined}
            onChange={(e) => {
              setInstanceDraft(e.target.value);
              setInstanceError(null); // typing is the correction; stop shouting about it
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                saveInstance();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                cancelInstance();
              }
            }}
          />
          <button onClick={saveInstance}>Save instance</button>
          <button onClick={cancelInstance}>Cancel</button>
          {instanceError && <span className="instance-error">{instanceError}</span>}
        </div>
      )}

      <div className="share">
        <span className="share-label">Share</span>
        {SHARES.map((s) => {
          // Two independent reasons a target cannot take this draft. Both disable
          // the button and say so, rather than opening a tab that drops the post.
          // Each network measures its own way — X bills any URL at 23 characters, the
          // rest count graphemes — so this is never the header's number for X.
          const { n, tooLong, noUrl, disabled, warn } = shareState(s, text, postUrl);
          return (
            <button
              key={s.key}
              className={`share-btn share-${s.key}${disabled ? " share-disabled" : ""}${warn ? " share-warn" : ""}`}
              disabled={disabled}
              onClick={() => share(s)}
              title={
                tooLong
                  ? s.soft
                    ? `${n} characters — over ${s.label}'s default ${s.limit}, but your instance may allow more`
                    : `${n} characters — ${s.label} takes ${s.limit}`
                  : noUrl
                    ? `${s.label} can only share a link, and this draft has no URL in it`
                    : s.needsInstance && !instance
                      ? "Choose your Mastodon instance"
                      : `Copy the text and open ${s.label}`
              }
            >
              {shared?.key === s.key ? (shared.copyFailed ? "Opened — copy failed" : "Opened ✓") : s.label}
            </button>
          );
        })}
        {instance && (
          <button
            type="button"
            className="instance-edit"
            onClick={() => openInstancePrompt()}
            title={`Posting to ${instance} — click to change it`}
          >
            {instance} ✎
          </button>
        )}
        <span className="hint share-hint">
          The post is copied to your clipboard where the browser allows it — Facebook (and
          sometimes LinkedIn) won't prefill it, so paste into the composer. If a button says
          "copy failed", use Copy post before pasting. A greyed target is over its length
          limit, or takes a link this draft doesn't have.
        </span>
      </div>
    </article>
  );
}
