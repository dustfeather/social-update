import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// WORK_DIR is resolved from the environment when the module first loads, so this
// has to be set before the import below, not inside a test.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "progress-"));
process.env.CLAUDE_WORK_DIR = dir;

const { readProgress, recordProgress, forgetProgress, compactProgress } =
  await import("../dist/claude-progress.js");

const ledger = path.join(dir, "progress.jsonl");
const legacy = path.join(dir, "progress.json");
const reset = () => {
  fs.rmSync(ledger, { force: true });
  fs.rmSync(legacy, { force: true });
};
const entry = (n) => ({ mtime: `2026-09-13T0${n}:00:00.000Z`, size: n * 100, written_at: "2026-09-13T12:00:00.000Z" });

test("an appended record reads back", () => {
  reset();
  recordProgress("a", entry(1));
  assert.deepEqual(readProgress(), { a: entry(1) });
});

test("each record costs exactly one line — earlier ones are not rewritten", () => {
  reset();
  recordProgress("a", entry(1));
  const afterFirst = fs.readFileSync(ledger, "utf8");
  recordProgress("b", entry(2));
  const afterSecond = fs.readFileSync(ledger, "utf8");
  assert.ok(afterSecond.startsWith(afterFirst), "the first line was rewritten");
  assert.equal(afterSecond.trimEnd().split("\n").length, 2);
});

test("a later line wins for the same session", () => {
  reset();
  recordProgress("a", entry(1));
  recordProgress("a", entry(3));
  assert.deepEqual(readProgress().a, entry(3));
});

test("a tombstone removes an entry", () => {
  reset();
  recordProgress("a", entry(1));
  recordProgress("b", entry(2));
  forgetProgress("a");
  assert.deepEqual(Object.keys(readProgress()), ["b"]);
});

// The point of the whole format: a crash mid-append costs the record being written
// and nothing else. A single JSON document would lose every session in the file.
test("a torn last line loses only that session", () => {
  reset();
  recordProgress("a", entry(1));
  recordProgress("b", entry(2));
  fs.appendFileSync(ledger, '{"session_id":"c","mtime":"2026-09');
  const progress = readProgress();
  assert.deepEqual(Object.keys(progress).sort(), ["a", "b"]);
  assert.deepEqual(progress.a, entry(1));
});

test("a torn line in the middle does not stop the lines after it", () => {
  reset();
  recordProgress("a", entry(1));
  fs.appendFileSync(ledger, "{not json\n");
  recordProgress("b", entry(2));
  assert.deepEqual(Object.keys(readProgress()).sort(), ["a", "b"]);
});

test("compaction collapses the file to one line per live session", () => {
  reset();
  recordProgress("a", entry(1));
  recordProgress("a", entry(3));
  recordProgress("b", entry(2));
  forgetProgress("b");
  const progress = readProgress();
  compactProgress(progress);
  assert.equal(fs.readFileSync(ledger, "utf8").trimEnd().split("\n").length, 1);
  assert.deepEqual(readProgress(), progress);
});

test("compacting an empty ledger leaves an empty file, not a broken one", () => {
  reset();
  recordProgress("a", entry(1));
  compactProgress({});
  assert.deepEqual(readProgress(), {});
});

test("appending after compaction still resumes both halves", () => {
  reset();
  recordProgress("a", entry(1));
  compactProgress(readProgress());
  recordProgress("b", entry(2));
  assert.deepEqual(Object.keys(readProgress()).sort(), ["a", "b"]);
});

test("a pre-JSONL progress.json is still read, and retired on compaction", () => {
  reset();
  fs.writeFileSync(legacy, JSON.stringify({ a: entry(1) }));
  assert.deepEqual(readProgress(), { a: entry(1) });
  compactProgress(readProgress());
  assert.equal(fs.existsSync(legacy), false);
  assert.deepEqual(readProgress(), { a: entry(1) });
});

test("the JSONL ledger wins over a stale progress.json", () => {
  reset();
  fs.writeFileSync(legacy, JSON.stringify({ a: entry(1) }));
  recordProgress("b", entry(2));
  assert.deepEqual(Object.keys(readProgress()), ["b"]);
});
