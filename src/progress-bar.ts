// A progress bar for a run measured in hours, not seconds.
//
// The collector's per-session lines answer "what happened"; over a 128-session run
// they do not answer "how much longer", which is the only question worth asking
// while watching it. Hence a bar with an ETA built from this run's own measured
// pace rather than from a constant — the per-session cost varies by a factor of two
// with transcript length, and a fixed estimate is wrong in whichever direction the
// backlog happens to lean.
//
// Everything here is a no-op off a TTY. The same binary runs under systemd, where
// carriage returns and ANSI escapes are not redrawing anything — they are stored,
// one journal entry per repaint. A bar that looks fine in a terminal turns a log
// into thousands of unreadable lines, so the non-TTY path keeps exactly the plain
// output it had before.

export interface Progress {
  /** Print a line above the bar. Use this instead of console.log while a run is live. */
  line(text: string): void;
  /** Print an error line above the bar. */
  error(text: string): void;
  /** One unit finished, having taken `ms` of wall clock. */
  advance(ms: number, failed?: boolean): void;
  /** Leave the bar behind and return the cursor to a clean line. */
  finish(): void;
}

const fmtDuration = (ms: number): string => {
  if (!isFinite(ms) || ms < 0) return "--";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
};

function ttyProgress(total: number, out: NodeJS.WriteStream): Progress {
  let done = 0;
  let failed = 0;
  // Mean of the last N, not of everything: the first item pays the model load, and
  // a long run drifts as it moves between projects with different session sizes. A
  // lifetime mean would keep reporting the start of the run an hour into it.
  const WINDOW = 12;
  const recent: number[] = [];
  let painted = false;

  const clear = () => {
    if (!painted) return;
    out.write("\r\x1b[2K");
    painted = false;
  };

  const paint = () => {
    const width = Math.max(40, Math.min(out.columns ?? 80, 120));
    const pct = total ? done / total : 0;
    const avg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
    const eta = avg ? avg * (total - done) : NaN;

    const head = `[${String(done).padStart(String(total).length)}/${total}]`;
    const tail =
      `${String(Math.round(pct * 100)).padStart(3)}%` +
      (avg ? `  ETA ${fmtDuration(eta)}  avg ${fmtDuration(avg)}` : "") +
      (failed ? `  ${failed} failed` : "");

    // Whatever is left after the text, spent on the bar itself — so a narrow
    // terminal loses the bar and keeps the numbers, which are the useful half.
    const barWidth = Math.max(0, width - head.length - tail.length - 4);
    let bar = "";
    if (barWidth > 4) {
      const filled = Math.round(pct * barWidth);
      bar = ` ${"█".repeat(filled)}${"░".repeat(barWidth - filled)} `;
    }
    out.write(`\r\x1b[2K${head}${bar} ${tail}`);
    painted = true;
  };

  return {
    line(text) {
      clear();
      out.write(text + "\n");
      paint();
    },
    error(text) {
      clear();
      process.stderr.write(text + "\n");
      paint();
    },
    advance(ms, isFailed = false) {
      done++;
      if (isFailed) failed++;
      else {
        recent.push(ms);
        if (recent.length > WINDOW) recent.shift();
      }
      paint();
    },
    finish() {
      clear();
    },
  };
}

export function createProgress(total: number, out: NodeJS.WriteStream = process.stdout): Progress {
  if (!out.isTTY || process.env.NO_PROGRESS === "1" || total <= 0) {
    return {
      line: (t) => console.log(t),
      error: (t) => console.error(t),
      advance: () => {},
      finish: () => {},
    };
  }
  return ttyProgress(total, out);
}
