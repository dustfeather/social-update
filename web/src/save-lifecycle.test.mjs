import test from "node:test";
import assert from "node:assert/strict";
import { createSaveLifecycle } from "./save-lifecycle.ts";

// A clock the test drives. `run()` fires every live timer, so a test never has to
// wait 800ms to find out what the debounce does.
function fakeClock() {
  const live = new Map();
  let next = 1;
  return {
    set(fn) {
      live.set(next, fn);
      return next++;
    },
    clear(t) {
      live.delete(t);
    },
    run() {
      const fns = [...live.values()];
      live.clear();
      for (const fn of fns) fn();
    },
    get pending() {
      return live.size;
    },
  };
}

// Records what the scheduled save saw, without any promise: `mine` is evaluated
// when the caller asks, which is the whole point of it being a function.
function recorder() {
  const calls = [];
  return {
    calls,
    run: (mine) => calls.push(mine),
  };
}

test("the debounce collapses a burst of keystrokes into one save", () => {
  const clock = fakeClock();
  const lc = createSaveLifecycle(800, "2026-W37", clock);
  const r = recorder();
  lc.schedule(r.run);
  lc.schedule(r.run);
  lc.schedule(r.run);
  assert.equal(clock.pending, 1);
  clock.run();
  assert.equal(r.calls.length, 1);
});

test("a save reports while its own scope is still on screen", () => {
  const clock = fakeClock();
  const lc = createSaveLifecycle(800, "2026-W37", clock);
  const r = recorder();
  lc.schedule(r.run);
  clock.run();
  assert.equal(r.calls[0](), true);
});

test("a result arriving after a scope change may not report", () => {
  const clock = fakeClock();
  const lc = createSaveLifecycle(800, "2026-W37", clock);
  const r = recorder();
  lc.schedule(r.run);
  clock.run();
  lc.setScope("2026-W38"); // the request is out; the author moved on
  assert.equal(r.calls[0](), false);
});

test("flushing writes the pending edit instead of dropping it", () => {
  const clock = fakeClock();
  const lc = createSaveLifecycle(800, "2026-W37", clock);
  const r = recorder();
  lc.schedule(r.run);
  lc.flush(); // what a week switch does — clearTimeout alone would lose the edit
  assert.equal(r.calls.length, 1);
  assert.equal(clock.pending, 0);
});

test("a flushed save still belongs to the scope that scheduled it", () => {
  const clock = fakeClock();
  const lc = createSaveLifecycle(800, "2026-W37", clock);
  const r = recorder();
  lc.schedule(r.run);
  lc.flush();
  lc.setScope("2026-W38");
  // The edit was written to week 37's row, and week 38's header must not announce it.
  assert.equal(r.calls[0](), false);
});

test("flushing twice runs the save once — the timer and the flush share a path", () => {
  const clock = fakeClock();
  const lc = createSaveLifecycle(800, "2026-W37", clock);
  const r = recorder();
  lc.schedule(r.run);
  lc.flush();
  lc.flush();
  clock.run();
  assert.equal(r.calls.length, 1);
});

test("flushing with nothing pending is a no-op, not a spurious save", () => {
  const clock = fakeClock();
  const lc = createSaveLifecycle(800, "2026-W37", clock);
  const r = recorder();
  lc.flush();
  assert.equal(r.calls.length, 0);
});

test("unmounting writes the edit and forbids it from reporting afterwards", () => {
  const clock = fakeClock();
  const lc = createSaveLifecycle(800, "2026-W37", clock);
  const r = recorder();
  lc.schedule(r.run);
  lc.unmount();
  assert.equal(r.calls.length, 1, "the edit is saved on the way out");
  assert.equal(r.calls[0](), false, "but nothing is left to render it into");
});

test("a remount re-arms the lifecycle, the way StrictMode's double-invoke does", () => {
  const clock = fakeClock();
  const lc = createSaveLifecycle(800, "2026-W37", clock);
  // React's development double-invoke: mount, cleanup, mount again. A flag only
  // ever set to false stays false here, and every later save silently stops
  // reporting — the header sticks on "saving…" and no error ever renders.
  lc.unmount();
  lc.mount();
  const r = recorder();
  lc.schedule(r.run);
  clock.run();
  assert.equal(r.calls[0](), true);
});

test("regenerating replaces the row, so the old row's save may not report either", () => {
  const clock = fakeClock();
  // The scope is week AND row: regenerating stays in the same week, so a week-only
  // scope let the old row's result paint "saved ✓" over a never-saved new set.
  const lc = createSaveLifecycle(800, "2026-W37:41", clock);
  const r = recorder();
  lc.schedule(r.run);
  clock.run();
  lc.setScope("2026-W37:42");
  assert.equal(r.calls[0](), false);
});
