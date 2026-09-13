import path from "path";
import { config } from "dotenv";
import { fetchUntagged } from "./untagged";
import { assignTags } from "./tag-pass";
import { applyTags } from "./sink";
import { loadModel, unloadModel, LLM_MODEL } from "./llm";
import { replaceFileDurable } from "./durable";
import { WORK_DIR } from "./claude-sessions";

config({ quiet: true });

// Tag items that are already in the DB.
//
// The in-run pass (tag-pass.ts) only sees what its own run summarized, and the
// summaries are deleted as they import — so every row collected before that pass
// existed is untagged with nothing on disk left to tag it from. This walks the
// DB instead, rebuilding each candidate from the columns the importer wrote.
//
// Vocabulary is shared across the whole backlog exactly as in a run: one chunked
// pass, each chunk shown what the earlier ones chose. Tagging 180 rows in eight
// separate invocations would produce eight vocabularies.
//
// Progress is committed chunk by chunk, not once at the end: a pass over a
// backlog is minutes of GPU per chunk, and one that only wrote after the last
// chunk threw all of it away when the process was killed partway. A run
// interrupted now keeps every chunk that finished, and the rows it already
// tagged are no longer NULL, so a re-run picks up where it stopped.
//
//   node dist/tag-backfill.js [--dry-run] [--limit N] [--source claude] [--week 2026-W37]

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const DRY = args.includes("--dry-run");
const LIMIT = Number(flag("--limit") ?? 0);
const SOURCE = flag("--source") ?? "claude";
// One week at a time is the normal way to run this. The vocabulary is shared
// across whatever the pass is given, so a week tagged alone gets a vocabulary
// built from that week rather than from the whole backlog.
const WEEK = flag("--week");

async function main(): Promise<number> {
  const all = await fetchUntagged(SOURCE, WEEK);
  const candidates = LIMIT > 0 ? all.slice(0, LIMIT) : all;
  const scope = WEEK ? `source "${SOURCE}" in ${WEEK}` : `source "${SOURCE}"`;
  if (!candidates.length) {
    console.log(`[backfill] nothing untagged for ${scope}`);
    return 0;
  }
  console.log(
    `[backfill] ${all.length} untagged item(s) for ${scope}` +
    (candidates.length < all.length ? `, tagging the first ${candidates.length}` : "") +
    ` via ${LLM_MODEL}`
  );

  const file = path.join(WORK_DIR, "tags-backfill.json");
  const done: Record<string, string[]> = {};
  let updated = 0;

  // Each chunk lands as it validates. The DB write comes FIRST and `done` is only
  // marked once it returns: a chunk recorded as done before it stored would be
  // skipped by the retry at the end, which is the one thing this must not do.
  // The JSON file is rewritten alongside it, so a killed run still leaves the
  // tags it generated on disk.
  const commit = async (chunk: Record<string, string[]>): Promise<void> => {
    if (!DRY) updated += await applyTags(SOURCE, chunk);
    Object.assign(done, chunk);
    replaceFileDurable(file, JSON.stringify(done, null, 2));
    if (!DRY) console.log(`[backfill] committed ${updated}/${Object.keys(done).length} tagged item(s) so far`);
  };

  let loadedByUs = false;
  let result;
  try {
    loadedByUs = await loadModel();
    result = await assignTags(
      candidates,
      (line) => console.log(line.replace("[collect] claude:", "[backfill]")),
      commit
    );
  } finally {
    // Release as soon as the pass is over: writing tags does not need the GPU,
    // and the child holds ~7.9 GiB that nothing else on the box can use meanwhile.
    await unloadModel(loadedByUs);
  }

  const asked = Object.keys(result.tags).length;

  if (DRY) {
    console.log(`[backfill] --dry-run: ${asked} tag set(s) written to ${file}, nothing applied`);
    console.log(`[backfill] apply them with: npm run collect:tag ${file}`);
    return result.failed.length ? 1 : 0;
  }

  // A retry of whatever a per-chunk commit failed to store. Everything that did
  // land is already tagged, so this is a no-op write in the normal case.
  const missed = Object.fromEntries(Object.entries(result.tags).filter(([id]) => !(id in done)));
  if (Object.keys(missed).length) updated += await applyTags(SOURCE, missed);

  replaceFileDurable(
    path.join(WORK_DIR, "tag-backfill-report.json"),
    JSON.stringify({ week: WEEK ?? null, asked, updated, untagged: result.failed, errors: result.errors }, null, 2)
  );
  console.log(`[backfill] tagged ${updated}/${asked} item(s)`);
  if (result.failed.length) {
    console.log(`[backfill] ${result.failed.length} item(s) stay untagged — run again to retry them`);
  }
  // Fewer rows updated than asked means the ids no longer match rows, which is
  // worth a nonzero exit; a chunk the model could not tag is not — it is the
  // documented outcome and the next run picks those up.
  return updated === asked ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[backfill] ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
);
