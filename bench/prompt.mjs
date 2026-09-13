// The prompt the model is judged on — re-exported from the pipeline.
//
// Identical to what production sends, by construction rather than by discipline:
// a benchmark scoring its own copy of the prompt measures the copy. Same argument
// for the validator, which is the compiled TypeScript the importer runs.
//
// Requires `npm run build` first.

import { createRequire } from "module";
import path from "path";

const require = createRequire(import.meta.url);
const DIST = path.join(import.meta.dirname, "..", "dist");

export const { validateSummary, SCHEMA_DOC, OUTCOMES } = require(path.join(DIST, "summary.js"));
export const { SYSTEM, userMessage, correctionMessage } = require(path.join(DIST, "summarize.js"));
