import fs from "fs";
import path from "path";
import { applyTags } from "./sink";
import { WORK_DIR } from "./claude-sessions";
import { validateTags } from "./tags";

// The tagging half of the run. Tags are assigned in ONE pass over every summary
// rather than per sub-agent, because a vocabulary is only useful if it is shared:
// two sessions about the same thing must come back with the same tag, and a
// sub-agent that saw one transcript cannot know that.

const file = process.argv[2] ?? path.join(WORK_DIR, "tags.json");

let parsed: unknown;
try {
  parsed = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (e) {
  console.error(`[tag] cannot read ${file}: ${(e as Error).message}`);
  process.exit(1);
}

const errs = validateTags(parsed);
if (errs.length) {
  console.error(`[tag] ${file} is invalid:`);
  for (const e of errs) console.error(`       - ${e}`);
  process.exit(1);
}

applyTags("claude", parsed as Record<string, string[]>).then(
  (updated) => {
    const asked = Object.keys(parsed as object).length;
    const report = { asked, updated };
    fs.writeFileSync(path.join(WORK_DIR, "tag-report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    // Fewer rows updated than tagged means the tag file names sessions that were
    // never imported — worth failing on, not worth guessing about.
    process.exit(updated === asked ? 0 : 1);
  },
  (err) => {
    console.error(`[tag] ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
);
