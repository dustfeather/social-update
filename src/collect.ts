import fs from "fs";
import path from "path";
import { replaceFileDurable } from "./durable";
import { collectClaude } from "./claude";
import { WORK_DIR } from "./claude-sessions";
import { createRunReporter, nullReporter, type RunReporter } from "./run-progress";
import { reportRunProgress } from "./sink";

// Single entry point for collection. Claude Code sessions are the only source:
// GitHub events duplicated what the sessions already say (and said it in commit
// subjects), Obsidian notes and claude.ai conversations were mostly not about the
// work being journalled. Removed 2026-09-12 — see git history for the collectors.
type Collector = { name: string; run: (report: RunReporter) => Promise<number> };

const collectors: Collector[] = [{ name: "claude", run: collectClaude }];

// Exit codes, because a caller should not have to read our prose to know what
// happened. The watchdog used to `grep -q FAILED` over the captured output, which
// forced it to buffer the whole run in a variable — no output for three hours, and
// no TTY for the collector, so the progress bar could never render. Worse, the test
// was a string match against our own log: rewording one message would have silently
// disabled the alert.
//
//   0  every collector finished
//   1  the process itself failed (unhandled error)
//   2  a collector failed; the others still ran and their items are committed
const EXIT_SOURCE_FAILED = 2;

// The queue row this process is working for, handed down by the poller so progress
// lands on the right one. Absent when collect is run by hand: nothing to report to.
function runReporter(): RunReporter {
  const raw = process.env.COLLECT_RUN_ID;
  if (!raw) return nullReporter;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    console.warn(`[collect] ignoring COLLECT_RUN_ID=${JSON.stringify(raw)} — not a run id`);
    return nullReporter;
  }
  return createRunReporter({ send: (p) => reportRunProgress(id, p) });
}

async function main(): Promise<number> {
  let total = 0;
  let failedSources = 0;
  const report = runReporter();
  for (const c of collectors) {
    try {
      const n = await c.run(report);
      total += n;
      console.log(`[collect] ${c.name}: ${n} item${n === 1 ? "" : "s"} written`);
    } catch (err) {
      failedSources++;
      console.error(`[collect] ${c.name}: FAILED —`, err instanceof Error ? err.message : err);
    }
  }
  report.stop();
  console.log(`[collect] done — ${total} item${total === 1 ? "" : "s"} written`);

  // A result FILE, because the caller needs the number and the log is not an API.
  // The poller used to recover it with `grep -oE '[0-9]+ new items? total'` over the
  // captured output — a pattern matching text this program has not printed for some
  // time (it says "N items written"), so every run reported inserted=0 to the UI and
  // nothing failed loudly enough to notice. Written before the exit so a reader that
  // sees the process gone can trust the file is there.
  try {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    const tmp = path.join(WORK_DIR, "last-run.json.tmp");
    fs.writeFileSync(tmp, JSON.stringify({
      inserted: total,
      failed_sources: failedSources,
      finished_at: new Date().toISOString(),
    }, null, 2));
    fs.renameSync(tmp, path.join(WORK_DIR, "last-run.json"));
  } catch (err) {
    console.error("[collect] could not write last-run.json:", err instanceof Error ? err.message : err);
  }

  return failedSources ? EXIT_SOURCE_FAILED : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("[collect] fatal:", err);
    process.exit(1);
  }
);
