// The excerpter now lives in the pipeline itself (src/excerpt.ts) rather than here.
//
// The benchmark and the collector MUST read identical bytes for a session, or the
// benchmark stops predicting what production will do — which is the only reason to
// run it. So this is a re-export of the compiled module, not a second copy: there
// is no way for the two to drift apart.
//
// Requires `npm run build` first, same as bench/prompt.mjs.

import { createRequire } from "module";
import path from "path";

const require = createRequire(import.meta.url);
const { sessionCwd, extractTurns, excerpt } = require(
  path.join(import.meta.dirname, "..", "dist", "excerpt.js")
);

export { sessionCwd, extractTurns, excerpt };
