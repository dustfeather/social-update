// Progress of a collection run, reported to the server so the UI's "Collect now"
// button can draw a bar instead of saying "Collecting…" for three hours.
//
// This is the remote twin of progress-bar.ts: that one repaints a terminal, this one
// posts `{done, total, eta_ms}` to /api/collect/:id/progress. The ETA is built the
// same way — the mean of the last WINDOW successful sessions, not of the whole run,
// because the first one pays the model load and the pace drifts between projects.
//
// Every post is also a HEARTBEAT. The server reclaims a 'running' row it has not
// heard from, and before this it only ever heard from the poller at the very end —
// so a run lasting longer than the stale window was marked "presumed dead" while it
// was still summarizing, and the button re-armed on top of it. The timer keeps
// posting between sessions, and before and after the summarize loop, where nothing
// advances for minutes at a time.
//
// Best-effort throughout: a report that fails is logged once and dropped. The run
// is the work; the bar is a view of it, and must never be the reason it stops.

export interface RunProgress {
  /** Both null until start(): the heartbeat runs before the work has been counted,
   *  and 0/0 would read as "nothing to do". */
  done: number | null;
  total: number | null;
  /** null until at least one session has finished and there is a pace to project. */
  eta_ms: number | null;
}

export interface RunReporter {
  /** The size of the work is known. Resets the count; posts immediately. */
  start(total: number): void;
  /** One unit finished, having taken `ms` of wall clock. */
  advance(ms: number, failed?: boolean): void;
  /** No more units will finish in this run — the rest stay pending for the next
   *  one. Closes the count at what was done, so the UI moves past the ETA. */
  finish(): void;
  /** Stop the heartbeat. Idempotent. */
  stop(): void;
}

const WINDOW = 12;
export const HEARTBEAT_MS = 60_000;

export interface ReporterDeps {
  send: (p: RunProgress) => Promise<void>;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  warn?: (msg: string) => void;
}

export function createRunReporter(deps: ReporterDeps): RunReporter {
  const every = deps.setInterval ?? ((fn, ms) => {
    const h = setInterval(fn, ms);
    // Never the thing keeping the process alive once the run has returned.
    h.unref();
    return h;
  });
  const cancel = deps.clearInterval ?? ((h) => clearInterval(h as NodeJS.Timeout));
  const warn = deps.warn ?? ((m) => console.warn(m));

  let done = 0;
  let total = 0;
  const recent: number[] = [];
  let started = false;
  let warned = false;

  const snapshot = (): RunProgress => {
    if (!started) return { done: null, total: null, eta_ms: null };
    const avg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
    return { done, total, eta_ms: avg ? Math.round(avg * Math.max(0, total - done)) : null };
  };

  // One in flight at a time. A report is a replacement, not a delta, so a newer one
  // queued behind a slow request supersedes anything queued before it.
  let inFlight = false;
  let queued = false;
  const post = () => {
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    deps
      .send(snapshot())
      .catch((e) => {
        if (warned) return;
        warned = true;
        warn(`[collect] progress report failed (further failures are silent) — ${e instanceof Error ? e.message : e}`);
      })
      .finally(() => {
        inFlight = false;
        if (queued) {
          queued = false;
          post();
        }
      });
  };

  let handle: unknown = every(post, HEARTBEAT_MS);
  post(); // the row is 'running' from the moment the poller claimed it; say so now

  return {
    start(n) {
      started = true;
      total = Math.max(0, n);
      done = 0;
      recent.length = 0;
      post();
    },
    advance(ms, failed = false) {
      done = Math.min(total, done + 1);
      if (!failed) {
        recent.push(ms);
        if (recent.length > WINDOW) recent.shift();
      }
      post();
    },
    finish() {
      if (!started || total === done) return;
      total = done;
      post();
    },
    stop() {
      if (handle === null) return;
      cancel(handle);
      handle = null;
    },
  };
}

// Used where no run is being tracked: a collect started by hand from a terminal, or
// an older poller that does not pass COLLECT_RUN_ID.
export const nullReporter: RunReporter = { start() {}, advance() {}, finish() {}, stop() {} };
