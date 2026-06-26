#!/usr/bin/env node
// graphify-watch — repo-scope driver for graphify-bridge (the vault side is the
// vault-repos TIMER).
//
// Why split the driver by scope: the Obsidian vault lives on /mnt/c, where Linux
// file watchers don't work (no inotify over the 9p mount) — so vault changes are
// picked up by the vault-repos systemd TIMER. Code repos live on the Linux fs,
// where watching DOES work, so this long-running service re-bridges within
// seconds of any repo commit instead of waiting for the daily timer.
//
// What we watch: each repo's post-commit hook runs
//   graphify update . && graphify global add graphify-out/graph.json --as <tag>
// which rewrites ~/.graphify/global-graph.json — the single federated file that is
// exactly graphify-bridge's input. So we watch THAT one file (changes on every
// repo commit) and, debounced, run graphify-bridge.mjs.
//
//   node scripts/graphify-watch.mjs         # run in foreground (Ctrl-C to stop)
// Installed as a systemd --user service: scripts/install-graphify-watch.sh
//   journalctl --user -t graphify-watch -f

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HOME = os.homedir();
const GLOBAL = path.join(HOME, ".graphify", "global-graph.json");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, "graphify-bridge.mjs");
const POLL = Number(process.env.POLL || 5) * 1000;       // mtime poll interval
const DEBOUNCE = Number(process.env.DEBOUNCE || 20) * 1000; // settle window after a burst

const log = (m) => console.log(`graphify-watch: ${m}`);

let timer = null;
let running = false;

function rebuild() {
  if (running) { log("rebuild already in progress; will re-check after"); return; }
  running = true;
  log("global-graph changed -> running graphify-bridge");
  try {
    const out = execFileSync("node", [BRIDGE], { encoding: "utf8" });
    const tail = out.trim().split("\n").slice(-3).join(" | ");
    log(`graphify-bridge done: ${tail}`);
  } catch (e) {
    log(`graphify-bridge FAILED: ${e.message}`);
  } finally {
    running = false;
  }
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(rebuild, DEBOUNCE); // debounce bursty commits into one rebuild
}

if (!fs.existsSync(GLOBAL)) {
  log(`WARNING: ${GLOBAL} not found yet; watching for it to appear`);
}
log(`started (watching ${GLOBAL}, poll=${POLL / 1000}s debounce=${DEBOUNCE / 1000}s)`);

// watchFile = built-in mtime polling; robust on ext4 and survives the file being
// rewritten/replaced by `graphify global add`.
fs.watchFile(GLOBAL, { interval: POLL }, (cur, prev) => {
  if (cur.mtimeMs !== prev.mtimeMs && cur.size > 0) schedule();
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
