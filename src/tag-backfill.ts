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
//   node dist/tag-backfill.js [--dry-run] [--limit N] [--source claude]

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const DRY = args.includes("--dry-run");
const LIMIT = Number(flag("--limit") ?? 0);
const SOURCE = flag("--source") ?? "claude";

async function main(): Promise<number> {
  const all = await fetchUntagged(SOURCE);
  const candidates = LIMIT > 0 ? all.slice(0, LIMIT) : all;
  if (!candidates.length) {
    console.log(`[backfill] nothing untagged for source "${SOURCE}"`);
    return 0;
  }
  console.log(
    `[backfill] ${all.length} untagged item(s)` +
    (candidates.length < all.length ? `, tagging the first ${candidates.length}` : "") +
    ` via ${LLM_MODEL}`
  );

  let loadedByUs = false;
  let result;
  try {
    loadedByUs = await loadModel();
    result = await assignTags(candidates, (line) => console.log(line.replace("[collect] claude:", "[backfill]")));
  } finally {
    // Release before the POST: writing tags does not need the GPU, and the child
    // holds ~7.9 GiB that nothing else on the box can use meanwhile.
    await unloadModel(loadedByUs);
  }

  const file = path.join(WORK_DIR, "tags-backfill.json");
  replaceFileDurable(file, JSON.stringify(result.tags, null, 2));
  const asked = Object.keys(result.tags).length;

  if (DRY) {
    console.log(`[backfill] --dry-run: ${asked} tag set(s) written to ${file}, nothing applied`);
    console.log(`[backfill] apply them with: npm run collect:tag ${file}`);
    return result.failed.length ? 1 : 0;
  }

  const updated = await applyTags(SOURCE, result.tags);
  replaceFileDurable(
    path.join(WORK_DIR, "tag-backfill-report.json"),
    JSON.stringify({ asked, updated, untagged: result.failed, errors: result.errors }, null, 2)
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
