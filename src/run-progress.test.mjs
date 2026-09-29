import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { createRunReporter, HEARTBEAT_MS } = await import("../dist/run-progress.js");

// A send that records every report and resolves only when told to, so the tests
// can hold a request in flight.
function harness() {
  const sent = [];
  const pending = [];
  let tick = null;
  const r = createRunReporter({
    send: (p) => {
      sent.push(p);
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
    setInterval: (fn, ms) => {
      assert.equal(ms, HEARTBEAT_MS);
      tick = fn;
      return "h";
    },
    clearInterval: () => {
      tick = null;
    },
    warn: () => {},
  });
  const settle = async (ok = true) => {
    const p = pending.shift();
    ok ? p.resolve() : p.reject(new Error("offline"));
    await new Promise((r) => setImmediate(r));
  };
  return { r, sent, settle, heartbeat: () => tick?.(), stopped: () => tick === null };
}

test("posts at once, then single-flight: only the newest queued report is sent", async () => {
  const h = harness();
  assert.deepEqual(h.sent, [{ done: null, total: null, eta_ms: null }], "uncounted, not 0/0");
  h.r.start(4);
  h.r.advance(1000);
  assert.equal(h.sent.length, 1, "nothing new goes out while the first is in flight");
  await h.settle();
  assert.equal(h.sent.length, 2);
  assert.deepEqual(h.sent[1], { done: 1, total: 4, eta_ms: 3000 });
});

test("the ETA is the recent mean times what is left, and a failed session adds no pace", async () => {
  const h = harness();
  await h.settle();
  h.r.start(5);
  await h.settle();
  h.r.advance(2000);
  await h.settle();
  h.r.advance(99_999, true);
  await h.settle();
  h.r.advance(4000);
  await h.settle();
  assert.deepEqual(h.sent.at(-1), { done: 3, total: 5, eta_ms: 6000 });
});

test("done never passes total", async () => {
  const h = harness();
  await h.settle();
  h.r.start(1);
  await h.settle();
  h.r.advance(10);
  await h.settle();
  h.r.advance(10);
  await h.settle();
  assert.deepEqual(h.sent.at(-1), { done: 1, total: 1, eta_ms: 0 });
});

test("finish() closes the count at what was done, once", async () => {
  const h = harness();
  await h.settle();
  h.r.start(10);
  await h.settle();
  h.r.advance(1000);
  await h.settle();
  h.r.finish();
  assert.deepEqual(h.sent.at(-1), { done: 1, total: 1, eta_ms: 0 });
  await h.settle();
  const n = h.sent.length;
  h.r.finish();
  assert.equal(h.sent.length, n, "a second finish sends nothing");
});

test("the heartbeat re-sends the current state; a failed send does not stop it; stop() ends it", async () => {
  const h = harness();
  await h.settle(false);
  h.r.start(3);
  await h.settle();
  h.heartbeat();
  assert.deepEqual(h.sent.at(-1), { done: 0, total: 3, eta_ms: null });
  await h.settle();
  h.r.stop();
  assert.ok(h.stopped());
  h.r.stop(); // idempotent
});

test("server: a heartbeat keeps a long run alive; a silent one is reclaimed; a finished run refuses progress", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-progress-"));
  process.env.DB_PATH = path.join(dir, "t.sqlite");
  const { db, setRunProgress, latestRun } = await import("../dist/db.js");
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const ins = db.prepare(
    `INSERT INTO collect_runs (status, source, requested_at, started_at) VALUES ('running','manual',?,?)`
  );
  const silent = Number(ins.run(hourAgo, hourAgo).lastInsertRowid);
  const alive = Number(ins.run(hourAgo, hourAgo).lastInsertRowid);

  assert.equal(setRunProgress(alive, { done: 3, total: 10, eta_ms: 700 }), true);
  const run = latestRun(); // reclaims as a side effect
  assert.equal(run.id, alive);
  assert.equal(run.status, "running");
  assert.deepEqual([run.progress_done, run.progress_total, run.progress_eta_ms], [3, 10, 700]);

  const dead = db.prepare("SELECT status, error FROM collect_runs WHERE id = ?").get(silent);
  assert.equal(dead.status, "error");
  assert.match(dead.error, /presumed dead/);
  assert.equal(setRunProgress(silent, { done: 1, total: 1, eta_ms: null }), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
