import test from "node:test";
import assert from "node:assert/strict";
import { collectBar, generateBar, createLineSplitter, fmtDuration } from "./progress.ts";

const run = (over) => ({
  id: 1,
  status: "running",
  source: "manual",
  requested_at: "",
  started_at: "",
  finished_at: null,
  inserted: null,
  error: null,
  progress_done: null,
  progress_total: null,
  progress_eta_ms: null,
  heartbeat_at: null,
  ...over,
});

test("collectBar: nothing to show once a run is over", () => {
  assert.equal(collectBar(null), null);
  assert.equal(collectBar(run({ status: "done" })), null);
  assert.equal(collectBar(run({ status: "error" })), null);
});

test("collectBar: indeterminate while queued or not yet counted", () => {
  assert.equal(collectBar(run({ status: "pending" })).value, null);
  assert.equal(collectBar(run({})).value, null);
  assert.equal(collectBar(run({ progress_done: 0, progress_total: 0 })).value, null);
});

test("collectBar: a real fraction with the collector's ETA", () => {
  const v = collectBar(run({ progress_done: 3, progress_total: 12, progress_eta_ms: 810_000 }));
  assert.equal(v.value, 0.25);
  assert.equal(v.label, "3/12 sessions · ~13m 30s left");
  assert.equal(collectBar(run({ progress_done: 1, progress_total: 4 })).label, "1/4 sessions");
});

test("collectBar: full, and says what it is still doing, once every session is summarized", () => {
  const v = collectBar(run({ progress_done: 5, progress_total: 5, progress_eta_ms: 0 }));
  assert.equal(v.value, 1);
  assert.match(v.label, /importing and tagging/);
});

test("generateBar: a segment per model pass", () => {
  assert.deepEqual(generateBar(null, 2000), { value: null, label: "Starting… · 2s" });
  assert.deepEqual(generateBar("drafting", 61_000), {
    value: 0,
    label: "Drafting (1/2) · 1m 01s",
    active: [0, 0.5],
  });
  assert.deepEqual(generateBar("humanizing", 3_700_000).active, [0.5, 1]);
  assert.equal(generateBar("humanizing", 0).value, 0.5);
});

test("fmtDuration", () => {
  assert.equal(fmtDuration(-1), "--");
  assert.equal(fmtDuration(59_400), "59s");
  assert.equal(fmtDuration(7_260_000), "2h 01m");
});

test("createLineSplitter: lines split across chunks, and a character split across chunks", () => {
  const s = createLineSplitter();
  const bytes = new TextEncoder().encode('{"a":"ș"}\n{"b":1}\n{"c"');
  const cut = 7; // inside the two-byte ș
  assert.deepEqual(s.push(bytes.slice(0, cut)), []);
  assert.deepEqual(s.push(bytes.slice(cut)), ['{"a":"ș"}', '{"b":1}']);
  assert.deepEqual(s.push(new TextEncoder().encode(":2}")), []);
  assert.deepEqual(s.end(), ['{"c":2}']);
});
