import fs from "fs";
import path from "path";
import { validateFile } from "./summary";

// Validate one summary file or a whole directory of them. Kept apart from
// summary.ts so that module stays importable as ESM: a file carrying a
// `require.main` guard is treated as CommonJS, and its named exports then come
// through a lexer that misses some of them.
//
// Exits nonzero on any failure so a sub-agent can loop on it without parsing
// stdout, and prints the offending field rather than a parser offset.
const target = process.argv[2];
if (!target) {
  console.error("usage: summary-validate <file.json | directory>");
  process.exit(2);
}

const files = fs.statSync(target).isDirectory()
  ? fs.readdirSync(target).filter((f) => f.endsWith(".json")).map((f) => path.join(target, f))
  : [target];

if (files.length === 0) {
  console.error(`no .json files in ${target}`);
  process.exit(1);
}

let bad = 0;
for (const f of files) {
  const errs = validateFile(f);
  if (errs.length === 0) {
    console.log(`OK   ${path.basename(f)}`);
  } else {
    bad++;
    console.error(`FAIL ${path.basename(f)}`);
    for (const e of errs) console.error(`       - ${e}`);
  }
}
console.log(`${files.length - bad}/${files.length} valid`);
process.exit(bad ? 1 : 0);
