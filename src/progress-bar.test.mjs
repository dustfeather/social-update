import { test } from "node:test";
import assert from "node:assert/strict";

const { createProgress } = await import("../dist/progress-bar.js");

const fakeTty = (columns = 90) => ({
  isTTY: true,
  columns,
  buf: [],
  write(s) { this.buf.push(s); },
  get text() { return this.buf.join(""); },
});

test("off a TTY the bar paints nothing at all", () => {
  // The same binary runs under systemd, where a repaint is not a repaint — it is
  // another journal entry. Painting there turns one run into thousands of lines.
  const out = { isTTY: false, columns: 80, write() { throw new Error("painted off a TTY"); } };
  const bar = createProgress(10, out);
  bar.advance(1000);
  bar.finish();
});

test("NO_PROGRESS=1 disables it on a TTY too", () => {
  process.env.NO_PROGRESS = "1";
  const out = fakeTty();
  createProgress(10, out).advance(1000);
  delete process.env.NO_PROGRESS;
  assert.equal(out.buf.length, 0);
});

test("the ETA comes from this run's measured pace", () => {
  const out = fakeTty();
  const bar = createProgress(100, out);
  for (let i = 0; i < 4; i++) bar.advance(60_000); // 1m each, 96 left => 1h36m
  assert.match(out.text, /ETA 1h36m/);
});

test("a failed unit advances the count but not the average", () => {
  const out = fakeTty();
  const bar = createProgress(10, out);
  bar.advance(60_000);
  bar.advance(1_000, true); // a fast failure must not make the ETA optimistic
  assert.match(out.text, /avg 1m00s/);
  assert.match(out.text, /1 failed/);
});

test("a line prints above the bar and the bar is repainted under it", () => {
  const out = fakeTty();
  const bar = createProgress(10, out);
  bar.advance(60_000);
  const before = out.buf.length;
  bar.line("hello");
  assert.ok(out.buf.slice(before).some((s) => s === "hello\n"));
  assert.match(out.buf.at(-1), /\[ 1\/10\]/); // bar redrawn last
});

test("finish leaves the cursor on a clean line", () => {
  const out = fakeTty();
  const bar = createProgress(10, out);
  bar.advance(60_000);
  bar.finish();
  assert.equal(out.buf.at(-1), "\r\x1b[2K");
});

test("a narrow terminal drops the bar and keeps the numbers", () => {
  const out = fakeTty(44);
  const bar = createProgress(100, out);
  bar.advance(60_000);
  const frame = out.buf.at(-1);
  assert.ok(!frame.includes("█"), "no bar at this width");
  assert.match(frame, /ETA/);
});
