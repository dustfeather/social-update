import fs from "fs";
import path from "path";
import { insertItems } from "./sink";
import { validateFile, SUMMARY_MAX, TITLE_MAX, type SessionSummary } from "./summary";
import { replaceFileDurable } from "./durable";
import { WORK_DIR, readState, writeState, type Manifest } from "./claude-sessions";
import type { ItemInput } from "./db";

// The import half of the collection run: every summary the sub-agents produced
// goes in as one item, in ONE batch. Run after the fan-out has finished — a
// partial directory imports partially and the missing sessions simply stay
// pending for the next run.

function toItem(s: SessionSummary): ItemInput {
  const bullets = s.highlights.map((h) => `- ${h}`).join("\n");
  return {
    source: "claude",
    external_id: s.session_id,
    // The project stays in the title because the UI lists items from every
    // project together, and "which repo was this" is the first thing you ask.
    title: `${s.project}: ${s.title}`.slice(0, TITLE_MAX),
    // The validator already bounds both halves; the slice is a floor under a
    // hand-edited summary file, not the thing that shapes the body.
    body: `${s.summary}\n\n${bullets}`.slice(0, SUMMARY_MAX * 2),
    url: null,
    occurred_at: s.occurred_at,
    raw_json: JSON.stringify({
      session_id: s.session_id,
      project: s.project,
      outcome: s.outcome,
      highlights: s.highlights,
    }),
  };
}

export interface ImportReport {
  imported: number;
  /** WHICH sessions landed, not just how many. The tagging pass writes tags by
   *  external_id, so it has to know exactly which rows exist — tagging a session
   *  whose summary was rejected here is a POST that updates nothing and then looks
   *  like the tag file naming a session that was never imported. */
  imported_ids: string[];
  written: number;
  invalid: Array<{ file: string; errors: string[] }>;
  missing: string[];
}

/**
 * Import the summaries on disk and advance state for the ones that landed.
 *
 * `only` narrows it to a subset of the manifest, which is how the collector
 * commits a long run in batches: a five-hour backlog that imported once at the end
 * lost everything it had done when the machine went down, because state.json is
 * what makes a session stop being pending. Importing is idempotent — the DB
 * upserts on (source, external_id) — so a batch replayed after a crash is
 * harmless.
 */
export async function importSummaries(only?: string[]): Promise<ImportReport> {
  const manifestPath = path.join(WORK_DIR, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;

  const wanted = only ? new Set(only) : null;
  const sessions = wanted ? manifest.sessions.filter((r) => wanted.has(r.session_id)) : manifest.sessions;

  const rows: ItemInput[] = [];
  const invalid: ImportReport["invalid"] = [];
  const missing: string[] = [];
  const imported: string[] = [];

  for (const ref of sessions) {
    const file = path.join(manifest.summary_dir, `${ref.session_id}.json`);
    if (!fs.existsSync(file)) {
      missing.push(ref.session_id); // sub-agent never wrote it — stays pending
      continue;
    }
    const errs = validateFile(file);
    if (errs.length) {
      invalid.push({ file: path.basename(file), errors: errs });
      continue;
    }
    const summary = JSON.parse(fs.readFileSync(file, "utf8")) as SessionSummary;
    rows.push(toItem(summary));
    imported.push(ref.session_id);
  }

  const written = await insertItems(rows);

  // Advance the fingerprint ONLY for sessions that actually landed. A summary
  // that failed validation, or was never written, must be retried next run —
  // which is exactly what leaving its state entry alone achieves.
  const state = readState();
  for (const ref of sessions) {
    if (imported.includes(ref.session_id)) {
      state[ref.session_id] = { mtime: ref.mtime, size: ref.size };
    }
  }
  writeState(state);

  return { imported: imported.length, imported_ids: imported, written, invalid, missing };
}

if (require.main === module) {
  importSummaries().then(
    (report) => {
      // Persist it too: the collector reads this file rather than trusting the
      // orchestrating agent's final message, which is prose and can be anything.
      replaceFileDurable(path.join(WORK_DIR, "import-report.json"), JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report, null, 2));
      // Invalid files are a real failure — the orchestrator should see a nonzero
      // exit and say so rather than reporting a clean run that dropped sessions.
      process.exit(report.invalid.length ? 1 : 0);
    },
    (err) => {
      console.error(`[import] ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  );
}
