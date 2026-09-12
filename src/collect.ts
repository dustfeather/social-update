import { collectClaude } from "./claude";

// Single entry point for collection. Claude Code sessions are the only source:
// GitHub events duplicated what the sessions already say (and said it in commit
// subjects), Obsidian notes and claude.ai conversations were mostly not about the
// work being journalled. Removed 2026-09-12 — see git history for the collectors.
type Collector = { name: string; run: () => Promise<number> };

const collectors: Collector[] = [{ name: "claude", run: collectClaude }];

async function main() {
  let total = 0;
  for (const c of collectors) {
    try {
      const n = await c.run();
      total += n;
      console.log(`[collect] ${c.name}: ${n} item${n === 1 ? "" : "s"} written`);
    } catch (err) {
      console.error(`[collect] ${c.name}: FAILED —`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`[collect] done — ${total} item${total === 1 ? "" : "s"} written`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("[collect] fatal:", err);
    process.exit(1);
  }
);
