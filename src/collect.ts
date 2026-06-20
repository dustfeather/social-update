import { collectGithub } from "./github";
import { collectObsidian } from "./obsidian";
import { collectClaude } from "./claude";
import { collectClaudeWeb } from "./claude-web";

// Single entry point for all collectors. Each is added as its slice lands.
// Runs every collector independently so one failing source never blocks the rest.
type Collector = { name: string; run: () => Promise<number> };

const collectors: Collector[] = [
  { name: "github", run: collectGithub },
  { name: "obsidian", run: collectObsidian },
  { name: "claude", run: collectClaude },
  { name: "claude-web", run: collectClaudeWeb },
];

async function main() {
  let total = 0;
  for (const c of collectors) {
    try {
      const n = await c.run();
      total += n;
      console.log(`[collect] ${c.name}: ${n} new item${n === 1 ? "" : "s"}`);
    } catch (err) {
      console.error(`[collect] ${c.name}: FAILED —`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`[collect] done — ${total} new item${total === 1 ? "" : "s"} total`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("[collect] fatal:", err);
    process.exit(1);
  }
);
