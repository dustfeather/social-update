// The collector's single-flight lock. Exercised against dist/ for the same
// reason the other suites are: the package is CommonJS, so a .mjs test cannot
// import the .ts sources directly.
//
// WORK_DIR is read at module load from CLAUDE_WORK_DIR, so the env var has to be
// set before the require — hence the createRequire dance rather than a top-level
// import.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "collect-lock-"));
process.env.CLAUDE_WORK_DIR = workDir;

const { acquireLock } = require("../dist/claude.js");
const lockPath = path.join(workDir, "collect.lock");

test("the first caller takes the lock", () => {
  fs.rmSync(lockPath, { force: true });
  assert.equal(acquireLock(), true);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, process.pid);
});

test("a second caller is refused while the holder is alive", () => {
  fs.rmSync(lockPath, { force: true });
  // A live pid that is not us: our own parent always qualifies.
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, started: new Date().toISOString() }));
  assert.equal(acquireLock(), false);
  // The refusal must leave the holder's lock intact, not stomp it.
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, process.ppid);
});

test("a lock left by a dead process is taken over, not honoured forever", () => {
  fs.rmSync(lockPath, { force: true });
  // PID 2^22 is above the default pid_max on Linux, so nothing can hold it.
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 4194304, started: "2026-01-01T00:00:00.000Z" }));
  assert.equal(acquireLock(), true);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, process.pid);
});

test("an unreadable lock is treated as stale rather than wedging collection", () => {
  fs.rmSync(lockPath, { force: true });
  fs.writeFileSync(lockPath, "{ not json");
  assert.equal(acquireLock(), true);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, process.pid);
});
