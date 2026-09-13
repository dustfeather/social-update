import fs from "fs";
import path from "path";
import { config } from "dotenv";
import { buildManifest, WORK_DIR } from "./claude-sessions";
import { importSummaries } from "./claude-import";
import { readProgress, writeProgress } from "./claude-progress";
import { summarizeSession } from "./summarize";
import { loadModel, unloadModel, LLM_MODEL, LLM_BASE } from "./llm";

config({ quiet: true });

// Collection is a loop over a local model, not an agent run.
//
// It used to be `claude -p` fanning out one sub-agent per session. That worked, but
// it spent Claude on the most mechanical half of the pipeline: reading a transcript
// and filling a six-field schema. A local model does that at 100% valid@1 over a
// stratified sample, so Claude is now spent only where judgement is actually
// required — drafting posts, and tagging across the batch once items are in the DB.
//
// What the loop gets in exchange for being dumber: it is deterministic, it has no
// tool surface for a transcript to inject into, and the prompt is one file instead
// of an orchestrator briefing sub-agents.

// A wall-clock ceiling on the whole run. Overrunning is graceful by construction —
// every session summarized so far is imported, and the ones never reached keep
// their state entry and come back next run — so this is a brake, not a deadline.
// (CLAUDE_AGENT_TIMEOUT_MIN is the old name from the agent era, still honoured.)
const BUDGET_MS =
  Number(process.env.CLAUDE_COLLECT_BUDGET_MIN ?? process.env.CLAUDE_AGENT_TIMEOUT_MIN ?? 120) * 60_000;

// Two collectors in the same WORK_DIR destroy each other: they write over one
// manifest, one progress ledger and one state file, and — with LC_ROUTER_MAX=1 —
// contend for the single model the router can hold, so the one that finishes first
// unloads the model out from under the other. It happens on its own: the systemd
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

export async function collectClaude(): Promise<number> {
  if (!acquireLock()) return 0;
  try {
    return await collectClaudeLocked();
  } finally {
    fs.rmSync(LOCK_PATH, { force: true });
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
// one wedged llama-server converts a recoverable outage into a 300-session sweep of
// failures, and the log looks like the model got catastrophically worse. Observed
// after SIGKILLing a run mid-generation: the next request came back
// `500 "Context size has been exceeded."` on a prompt that fits the context twice
// over, because the child still held the KV slot. Stopping leaves every unreached
// session pending, which is the outcome that costs nothing.
const MAX_CONSECUTIVE_TRANSPORT_FAILURES = Number(process.env.CLAUDE_MAX_TRANSPORT_FAILURES ?? 5);

async function collectClaudeLocked(): Promise<number> {
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
  writeProgress(progress);

  if (resumed.length) {
    console.log(`[collect] claude: resuming — ${resumed.length} summary(ies) already on disk and still current`);
  }
  console.log(
    `[collect] claude: ${count} session(s) pending, ${todo.length} to summarize via ${LLM_MODEL} @ ${LLM_BASE}`
  );

  // Everything summarized but not yet committed. Seeded with the resumed files so a
  // restart imports them even if the model is never needed again.
  let batch: string[] = [...resumed];
  let imported = 0;
  const flush = async (why: string) => {
    if (!batch.length) return;
    const report = await importSummaries(batch);
    fs.writeFileSync(path.join(WORK_DIR, "import-report.json"), JSON.stringify(report, null, 2));
    for (const bad of report.invalid) {
      // The validator ran at summarize time too, so a file invalid here was edited
      // between the two, or the two disagree — either way worth naming.
      console.error(`[collect] claude: ${bad.file} rejected at import — ${bad.errors.join("; ")}`);
    }
    // State has advanced for these; the files are now redundant and the ledger
    // entries would only keep stale fingerprints alive.
    for (const id of batch) {
      fs.rmSync(summaryFile(id), { force: true });
      delete progress[id];
    }
    writeProgress(progress);
    imported += report.written;
    console.log(`[collect] claude: committed ${report.written} item(s) (${why})`);
    batch = [];
  };

  let ok = 0;
  let failed = 0;
  let consecutiveTransportFailures = 0;
  let loadedByUs = false;
  const release = async () => { await unloadModel(loadedByUs); loadedByUs = false; };
  const onSignal = (sig: string) => {
    void (async () => {
      console.log(`\n[collect] claude: ${sig} — releasing the model and committing what is done`);
      await release();
      try { await flush(sig); } catch (e) { console.error(`[collect] claude: final commit failed: ${e}`); }
      process.exit(130);
    })();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const deadline = Date.now() + BUDGET_MS;
  try {
    if (todo.length) {
      // Load up front rather than letting the first session trigger it. A cold load
      // is seconds to tens of seconds; charged to session one it looks like a
      // pathologically slow session and sends you reading that transcript for a
      // reason that is not there.
      const t0 = Date.now();
      loadedByUs = await loadModel();
      console.log(
        loadedByUs
          ? `[collect] claude: loaded ${LLM_MODEL} in ${((Date.now() - t0) / 1000).toFixed(1)}s`
          : `[collect] claude: ${LLM_MODEL} was already resident — leaving it as found on exit`
      );
    }

    for (const [i, session] of todo.entries()) {
      if (Date.now() > deadline) {
        console.warn(
          `[collect] claude: ${BUDGET_MS / 60_000} min budget spent after ${i} session(s) — ` +
          `the remaining ${todo.length - i} stay pending for the next run`
        );
        break;
      }

      const label = `[${String(i + 1).padStart(3)}/${todo.length}] ${session.session_id.slice(0, 8)} ${session.project}`;
      const result = await summarizeSession(session);

      if (!result.ok) {
        failed++;
        console.error(`[collect] claude: ${label} FAILED after ${result.attempts} attempt(s) — ${result.errors[0]}`);
        if (result.transport) {
          if (++consecutiveTransportFailures >= MAX_CONSECUTIVE_TRANSPORT_FAILURES) {
            console.error(
              `[collect] claude: ${consecutiveTransportFailures} consecutive transport failures — ` +
              `the model server looks unwell, stopping. The remaining ` +
              `${todo.length - i - 1} session(s) stay pending.`
            );
            break;
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
      fs.writeFileSync(summaryFile(session.session_id), JSON.stringify(result.summary, null, 2));
      progress[session.session_id] = {
        mtime: session.mtime,
        size: session.size,
        written_at: new Date().toISOString(),
      };
      writeProgress(progress);

      ok++;
      batch.push(session.session_id);
      console.log(
        `[collect] claude: ${label} ok in ${(result.ms / 1000).toFixed(1)}s ` +
        `(${result.attempts} attempt${result.attempts === 1 ? "" : "s"})`
      );

      if (batch.length >= IMPORT_BATCH) await flush("batch");
    }
  } finally {
    // Release before the final commit: importing does not need the GPU, and a model
    // this run loaded holds ~7.9 GiB that nothing else on the box can use meanwhile.
    // One found already resident is left alone — it is not ours to evict.
    await release();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  await flush("final");
  console.log(`[collect] claude: summarized ${ok}, failed ${failed}, imported ${imported}`);
  // Tagging used to run inside the agent, over the whole batch at once. It is a
  // judgement call across sessions, not a per-session transform, so it stays a
  // Claude job: write WORK_DIR/tags.json and run `npm run collect:tag`.
  if (imported) console.log(`[collect] claude: items are untagged — run collect:tag to tag them`);
  return imported;
}
