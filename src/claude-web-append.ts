// Merge one chunk of the paged browser step into the payload file.
//
// The browser step returns a couple of conversations at a time (the tool-result
// cap makes a single big payload impossible — see ./claude-web-script), so the
// chunks have to be accumulated somewhere before the collector reads them.
// Dedups on uuid so re-running a page is harmless.
import fs from "fs";
import path from "path";
import os from "os";
import { config } from "dotenv";
import { expandHome } from "./paths";
import { parsePayload, type RawConvo } from "./claude-web";

config();

const PAYLOAD = expandHome(
  process.env.CLAUDE_WEB_PAYLOAD ??
    path.join(os.homedir(), ".cache", "social-update", "claude-web.json")
);

function main(): void {
  const chunk = parsePayload(fs.readFileSync(0, "utf8"));
  const existing: RawConvo[] = fs.existsSync(PAYLOAD)
    ? parsePayload(fs.readFileSync(PAYLOAD, "utf8"))
    : [];
  const byUuid = new Map(existing.map((c) => [c.uuid, c]));
  for (const c of chunk) byUuid.set(c.uuid, c);
  const merged = [...byUuid.values()];

  fs.mkdirSync(path.dirname(PAYLOAD), { recursive: true });
  fs.writeFileSync(PAYLOAD, JSON.stringify(merged), "utf8");
  console.log(`[claude-web] +${chunk.length} chunk → ${merged.length} in ${PAYLOAD}`);
}

main();
