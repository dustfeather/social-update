type Timer = ReturnType<typeof setTimeout>;

/** The two calls a debounce needs, injectable so a test can drive the clock. */
export interface Clock {
  set: (fn: () => void, ms: number) => Timer;
  clear: (t: Timer) => void;
}

export interface SaveLifecycle<S> {
  /** Called from the mount effect's BODY, not relied on from an initializer:
   *  StrictMode runs mount -> cleanup -> mount in development, so anything only
   *  ever set to false stays false for the rest of the session. */
  mount: () => void;
  /** Marks the component gone and flushes, in that order: the pending edit is
   *  still written, and its result is no longer allowed to report. */
  unmount: () => void;
  setScope: (next: S) => void;
  /** Runs a pending save NOW instead of dropping it. */
  flush: () => void;
  schedule: (run: (mine: () => boolean) => void) => void;
}

/**
 * Owns the ordering around a debounced save: when it fires, when it is flushed,
 * and which results are still allowed to report into the UI.
 *
 * It is here rather than in the component because all of it is decision, not
 * rendering — and because the interesting cases (a scope change mid-debounce, a
 * StrictMode remount, a result arriving after either) are ones a DOM-free test
 * can drive directly and a browser cannot be made to do on demand.
 */
export function createSaveLifecycle<S>(
  delayMs: number,
  initialScope: S,
  clock: Clock = { set: setTimeout, clear: clearTimeout },
): SaveLifecycle<S> {
  let mounted = true;
  let scope = initialScope;
  let pending: { timer: Timer; run: () => void } | null = null;

  function flush(): void {
    const p = pending;
    pending = null;
    if (p) {
      clock.clear(p.timer);
      p.run();
    }
  }

  function schedule(run: (mine: () => boolean) => void): void {
    if (pending) clock.clear(pending.timer);
    // Captured here, so it says which scope this save BELONGS to. `mine` reads
    // the live one, because whether reporting is correct is a question about
    // now: a save may be perfectly valid to WRITE and wrong to ANNOUNCE.
    const forScope = scope;
    const mine = () => mounted && scope === forScope;
    const fire = () => {
      pending = null;
      run(mine);
    };
    pending = { timer: clock.set(fire, delayMs), run: fire };
  }

  return {
    mount: () => {
      mounted = true;
    },
    unmount: () => {
      mounted = false;
      flush();
    },
    setScope: (next: S) => {
      scope = next;
    },
    flush,
    schedule,
  };
}
