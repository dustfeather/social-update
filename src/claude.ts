import fs from "fs";
import path from "path";
import { config } from "dotenv";
import { buildManifest, WORK_DIR } from "./claude-sessions";
import { createProgress } from "./progress-bar";
import { nullReporter, type RunReporter } from "./run-progress";
import { writeFileDurable, replaceFileDurable } from "./durable";
import { importSummaries } from "./claude-import";
import { readProgress, recordProgress, forgetProgress, compactProgress } from "./claude-progress";
import { summarizeSession } from "./summarize";
import type { SessionSummary } from "./summary";
import { assignTags, type TagCandidate, type TagPassResult } from "./tag-pass";
import { applyTags } from "./sink";
import { LLM_MODEL, LLM_BASE } from "./llm";

config({ quiet: true });

// Collection is a loop of plain completions on Haiku (see llm.ts), not an agent run.
//
// It was once `claude -p` fanning out one sub-agent per session, then a local
// llama.cpp model. The agent spent a big model on the most mechanical half of the
// pipeline — reading a transcript and filling a six-field schema; the local model
// owned the GPU for an eight-hour night. Haiku with no tools does the fill in
// seconds, several sessions at a time (CLAUDE_CONCURRENCY).
//
// Tagging is part of the run again (see tag-pass.ts). It is still one pass over the
// whole batch rather than a per-session call — that was always the constraint, and
// it is about the shape of the pass, not about which model runs it. What it buys:
// nothing leaves the run untagged waiting for a human to remember, which is what
// "items are untagged — run collect:tag" turned into in practice.
//
// What the loop gets in exchange for being dumber: it is deterministic, it has no
// tool surface for a transcript to inject into, and the prompt is one file instead
// of an orchestrator briefing sub-agents.

// A wall-clock ceiling on the whole run. Overrunning is graceful by construction —
// every session summarized so far is imported, and the ones never reached keep
// their state entry and come back next run — so this is a brake, not a deadline.
const BUDGET_MS = Number(process.env.CLAUDE_COLLECT_BUDGET_MIN ?? 120) * 60_000;

// Two collectors in the same WORK_DIR destroy each other: they write over one
// manifest, one progress ledger and one state file. It happens on its own: the systemd
// timer fires on a schedule and a manual backfill is exactly the kind of long run
// it lands in the middle of.
// The DB's enqueueRun() single-flight does not help: that guards POST /api/collect,
// and both the timer and a manual run invoke `node dist/collect.js` directly, which
// never touches it.
//
// "wx" is the whole mechanism — create-exclusive is atomic, so the loser of a race
// gets EEXIST rather than a torn read of somebody's pid.
const LOCK_PATH = path.join(WORK_DIR, "collect.lock");

export function acquireLock(): boolean {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  try {
    fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), {
      flag: "wx",
    });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }

  // A lock is present. A killed run leaves one behind, so a stale lock must not
  // wedge collection forever: if nothing is alive on that pid, take it over.
  let holder: { pid?: number; started?: string } = {};
  try {
    holder = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
  } catch {
    // Unreadable lock — treat as stale rather than blocking on garbage.
  }
  const alive = (() => {
    if (!holder.pid) return false;
    try {
      process.kill(holder.pid, 0); // signal 0 tests existence, sends nothing
      return true;
    } catch {
      return false;
    }
  })();

  if (alive) {
    console.log(
      `[collect] claude: another collection is running (pid ${holder.pid}, started ${holder.started}) — skipping`
    );
    return false;
  }

  console.warn(`[collect] claude: clearing a stale lock from pid ${holder.pid ?? "?"}`);
  fs.rmSync(LOCK_PATH, { force: true });
  fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), {
    flag: "wx",
  });
  return true;
}

/** Drop the lock. Pair it with a successful acquireLock(); a second call is harmless.
 *  Exported because collection is no longer the only job that holds the card — the tag
 *  backfill takes the same lock. */
export function releaseLock(): void {
  fs.rmSync(LOCK_PATH, { force: true });
}

export async function collectClaude(runReport: RunReporter = nullReporter): Promise<number> {
  if (!acquireLock()) return 0;
  try {
    return await collectClaudeLocked(runReport);
  } finally {
    releaseLock();
  }
}


// How many summaries to commit at once. Every import advances state.json for the
// sessions in it, which is what makes them stop being pending — so this is the
// granularity at which a crash stops costing work. Small enough that a power cut
// loses minutes, large enough that a 300-session run is not 300 round trips to the
// cluster's /api/ingest.
const IMPORT_BATCH = Number(process.env.CLAUDE_IMPORT_BATCH ?? 10);

// Stop the run after this many consecutive TRANSPORT failures.
//
// A model failure is per-session: a transcript the model cannot summarize says
// nothing about the next one. A transport failure is usually about the server, and
// an unwell server fails every remaining session in milliseconds — so without this,
// one outage (logged out, rate-limited, network down) converts into a 300-session
// sweep of failures, and the log looks like the model got catastrophically worse.
// Stopping leaves every unreached session pending, which is the outcome that costs
// nothing.
const MAX_CONSECUTIVE_TRANSPORT_FAILURES = Number(process.env.CLAUDE_MAX_TRANSPORT_FAILURES ?? 5);

// Sessions summarized at once. Each is an independent `claude -p` call; the work on
// this box is only spawning the CLI and reading the transcript.
const CONCURRENCY = Math.max(1, Math.floor(Number(process.env.CLAUDE_CONCURRENCY ?? 4)) || 4);

// Tagging in-run, off with CLAUDE_TAG=0. The escape hatch exists because the pass
// is the one part of a collection that spends the model on something other than
// getting the work into the DB: a backfill that only needs the rows can skip it and
// tag later with `npm run collect:tag`, which is unchanged.
const TAG_IN_RUN = process.env.CLAUDE_TAG !== "0";

async function collectClaudeLocked(runReport: RunReporter): Promise<number> {
  const manifest = buildManifest();
  const count = manifest.sessions.length;
  if (count === 0) {
    console.log("[collect] claude: no new or changed sessions since the last run");
    return 0;
  }

  const progress = readProgress();
  const summaryFile = (id: string) => path.join(manifest.summary_dir, `${id}.json`);

  // Can a summary already on disk be trusted for this session?
  //
  // Only if it was written from the transcript exactly as it stands now. A session
  // that has GROWN since would be imported as a summary of the shorter transcript,
  // and the import would advance state to the NEW fingerprint — so the turns added
  // since would never be summarized at all.
  const reusable = (ref: { session_id: string; mtime: string; size: number }): boolean => {
    if (!fs.existsSync(summaryFile(ref.session_id))) return false;
    const seen = progress[ref.session_id];
    if (seen) return seen.mtime === ref.mtime && seen.size === ref.size;
    // No ledger entry: either a summary from before the ledger existed, or one
    // written by the `claude -p` agent this loop replaced. It is still good if the
    // summary file is NEWER than the transcript it describes, which means whoever
    // wrote it had already seen the session's final content.
    try {
      return fs.statSync(summaryFile(ref.session_id)).mtimeMs >= Date.parse(ref.mtime);
    } catch {
      return false;
    }
  };

  const todo = manifest.sessions.filter((r) => !reusable(r));
  const resumed = manifest.sessions.filter((r) => reusable(r)).map((r) => r.session_id);

  // Anything in summaries/ that this manifest does not claim is dead: its session
  // aged out of the lookback window, or was already imported. Nothing wipes the
  // directory any more, so prune here or it grows without bound.
  const live = new Set(manifest.sessions.map((r) => r.session_id));
  let pruned = 0;
  for (const f of fs.readdirSync(manifest.summary_dir)) {
    if (!f.endsWith(".json")) continue;
    const id = f.slice(0, -".json".length);
    if (live.has(id)) continue;
    fs.rmSync(path.join(manifest.summary_dir, f), { force: true });
    delete progress[id];
    pruned++;
  }
  for (const id of Object.keys(progress)) {
    if (!live.has(id)) delete progress[id];
  }
  if (pruned) console.log(`[collect] claude: pruned ${pruned} stale summary file(s)`);
  // The one place the whole ledger is rewritten: everything above has just read it
  // and dropped what is dead, so this is the only moment the in-memory map is the
  // complete truth. Every write after this point appends a single line.
  compactProgress(progress);

  if (resumed.length) {
    console.log(`[collect] claude: resuming — ${resumed.length} summary(ies) already on disk and still current`);
  }
  console.log(
    `[collect] claude: ${count} session(s) pending, ${todo.length} to summarize via ${LLM_MODEL} @ ${LLM_BASE}`
  );

  // On a terminal this repaints one line; under systemd it is inert and the plain
  // per-session lines below are all that is written. See progress-bar.ts.
  const bar = createProgress(todo.length);
  // The same count, for the UI's "Collect now" bar. See run-progress.ts.
  runReport.start(todo.length);

  // Everything summarized but not yet committed. Seeded with the resumed files so a
  // restart imports them even if the model is never needed again.
  let batch: string[] = [...resumed];
  let imported = 0;
  // Which sessions actually reached the DB, and what the tagging pass will read.
  //
  // The candidates are collected as summaries are produced, not at flush time,
  // because flush DELETES each file the moment it is imported — by the end of the
  // run there is nothing left on disk to tag from. Resumed summaries are read here
  // for the same reason: they are already written and will be gone just as fast.
  const landed: string[] = [];
  const candidates: TagCandidate[] = [];
  const remember = (s: SessionSummary) =>
    candidates.push({
      session_id: s.session_id,
      project: s.project,
      title: s.title,
      outcome: s.outcome,
      highlights: s.highlights,
    });
  for (const id of resumed) {
    try {
      remember(JSON.parse(fs.readFileSync(summaryFile(id), "utf8")) as SessionSummary);
    } catch {
      // Unreadable or malformed — the importer rejects it too, so it will never be
      // in `landed` and nothing would be tagged with it anyway.
    }
  }

  // Workers keep pushing into `batch` while an import is in flight, so each flush
  // takes the batch it commits up front, and flushes run one at a time. A failed
  // flush must not poison the chain: the next one (the final, the signal's) still runs.
  let flushing: Promise<void> = Promise.resolve();
  const flush = (why: string) => (flushing = flushing.catch(() => {}).then(() => flushNow(why)));
  const flushNow = async (why: string) => {
    if (!batch.length) return;
    const ids = batch;
    batch = [];
    const report = await importSummaries(ids);
    replaceFileDurable(path.join(WORK_DIR, "import-report.json"), JSON.stringify(report, null, 2));
    for (const bad of report.invalid) {
      // The validator ran at summarize time too, so a file invalid here was edited
      // between the two, or the two disagree — either way worth naming.
      console.error(`[collect] claude: ${bad.file} rejected at import — ${bad.errors.join("; ")}`);
    }
    // State has advanced for these; the files are now redundant and the ledger
    // entries would only keep stale fingerprints alive.
    for (const id of ids) {
      fs.rmSync(summaryFile(id), { force: true });
      delete progress[id];
      forgetProgress(id);
    }
    imported += report.written;
    landed.push(...report.imported_ids);
    console.log(`[collect] claude: committed ${report.written} item(s) (${why})`);
  };

  let ok = 0;
  let failed = 0;
  let tagged: TagPassResult | undefined;
  let consecutiveTransportFailures = 0;
  const onSignal = (sig: string) => {
    void (async () => {
      bar.finish();
      console.log(`\n[collect] claude: ${sig} — committing what is done`);
      try { await flush(sig); } catch (e) { console.error(`[collect] claude: final commit failed: ${e}`); }
      process.exit(130);
    })();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const deadline = Date.now() + BUDGET_MS;
  try {
    // A small worker pool over the queue. Shared counters are safe — this is one JS
    // thread; only the awaits interleave. `stop` ends the pool from any worker.
    let next = 0;
    let stop = "";
    // A worker that dies must not leave the others running past the lock's release —
    // record the error, stop the pool, and rethrow once every worker has returned.
    let poolError: unknown;
    const worker = async () => {
      while (!stop && next < todo.length) {
        if (Date.now() > deadline) {
          stop =
            `[collect] claude: ${BUDGET_MS / 60_000} min budget spent after ${next} session(s) — ` +
            `the remaining ${todo.length - next} stay pending for the next run`;
          break;
        }
        const i = next++;
        const session = todo[i];
        const label = `[${String(i + 1).padStart(3)}/${todo.length}] ${session.session_id.slice(0, 8)} ${session.project}`;
        const startedAt = Date.now();
        const result = await summarizeSession(session);

        if (!result.ok) {
          failed++;
          bar.advance(Date.now() - startedAt, true);
          runReport.advance(Date.now() - startedAt, true);
          bar.error(`[collect] claude: ${label} FAILED after ${result.attempts} attempt(s) — ${result.errors[0]}`);
          if (result.transport) {
            if (++consecutiveTransportFailures >= MAX_CONSECUTIVE_TRANSPORT_FAILURES && !stop) {
              stop =
                `[collect] claude: ${consecutiveTransportFailures} consecutive transport failures — ` +
                `claude -p looks unwell, stopping. The remaining ` +
                `${todo.length - next} session(s) stay pending.`;
            }
          } else {
            consecutiveTransportFailures = 0;
          }
          continue;
        }
        consecutiveTransportFailures = 0;

        // Write the summary, then record the fingerprint it was written from. In that
        // order: a crash between the two leaves a summary with no ledger entry, which
        // the mtime check above still recognises. The reverse would leave a ledger
        // entry promising a file that does not exist.
        // Both writes are flushed to the disk before the worker moves on. An hour of
        // summaries sitting in the page cache is an hour of work a power cut takes.
        writeFileDurable(summaryFile(session.session_id), JSON.stringify(result.summary, null, 2));
        const entry = {
          mtime: session.mtime,
          size: session.size,
          written_at: new Date().toISOString(),
        };
        progress[session.session_id] = entry;
        recordProgress(session.session_id, entry);
        remember(result.summary!);

        ok++;
        batch.push(session.session_id);
        bar.advance(Date.now() - startedAt);
        runReport.advance(Date.now() - startedAt);
        bar.line(
          `[collect] claude: ${label} ok in ${(result.ms / 1000).toFixed(1)}s ` +
          `(${result.attempts} attempt${result.attempts === 1 ? "" : "s"})`
        );

        if (batch.length >= IMPORT_BATCH) {
          try {
            await flush("batch");
          } catch (e) {
            poolError ??= e;
            stop ||= `[collect] claude: import failed — ${e}`;
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
    if (stop) bar.error(stop);
    if (poolError) throw poolError;
    // The loop can stop short — time budget spent, model server unwell — and the UI
    // would otherwise sit on "N/M · ~Xh left" through tagging and the final import.
    runReport.finish();

    // Generating tags does not need the rows to exist — only APPLYING them does —
    // which is what lets this sit before the final commit and the POST after it.
    if (TAG_IN_RUN && candidates.length) {
      bar.line(`[collect] claude: tagging ${candidates.length} session(s) in one pass`);
      tagged = await assignTags(candidates, (line) => bar.line(line));
    }
  } finally {
    // Before any other output: the bar owns the current terminal line, and a log
    // line written over it leaves half a bar stranded in the scrollback.
    bar.finish();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  await flush("final");
  console.log(`[collect] claude: summarized ${ok}, failed ${failed}, imported ${imported}`);

  if (tagged) {
    // Only a row that exists can be tagged. A session whose summary was rejected at
    // import was still worth tagging speculatively — it cost one line of a prompt —
    // but POSTing it updates nothing and reads afterwards as a tag file naming a
    // session that was never imported, which is the one thing the tag report treats
    // as a failure.
    const live = new Set(landed);
    const tags = Object.fromEntries(Object.entries(tagged.tags).filter(([id]) => live.has(id)));
    const asked = Object.keys(tags).length;

    // Written whether or not the apply works: it is the replay input for
    // `npm run collect:tag` and the only record of what this pass decided.
    replaceFileDurable(path.join(WORK_DIR, "tags.json"), JSON.stringify(tags, null, 2));

    let updated = 0;
    let error: string | undefined;
    try {
      updated = await applyTags("claude", tags);
    } catch (e) {
      // A failed tag POST must not fail the run. The items are already in the DB;
      // what is missing is one column, and tags.json on disk is enough to add it.
      error = e instanceof Error ? e.message : String(e);
    }
    replaceFileDurable(
      path.join(WORK_DIR, "tag-report.json"),
      JSON.stringify({ asked, updated, untagged: tagged.failed, errors: tagged.errors, error }, null, 2)
    );

    if (error) {
      console.error(
        `[collect] claude: applying tags failed — ${error}. ` +
        `${WORK_DIR}/tags.json is written; \`npm run collect:tag\` applies it`
      );
    } else {
      const left = asked - updated + tagged.failed.length;
      console.log(
        `[collect] claude: tagged ${updated} item(s)` +
        (left > 0 ? `, ${left} left untagged — they come back on the next run` : "")
      );
    }
  } else if (imported) {
    console.log(`[collect] claude: CLAUDE_TAG=0 — items are untagged, run collect:tag to tag them`);
  }
  return imported;
}
