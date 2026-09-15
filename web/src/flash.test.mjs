import test from "node:test";
import assert from "node:assert/strict";
import { createFlasher } from "./flash.ts";

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
  };
}

// A badge: whatever was last written to it.
function badge() {
  const b = { value: null };
  return { b, set: (v) => (b.value = v) };
}

test("a badge lights up and clears itself when the window closes", () => {
  const clock = fakeClock();
  const f = createFlasher(1500, clock);
  const copied = badge();
  f.show("copied", copied.set, "post");
  assert.equal(copied.b.value, "post");
  clock.run();
  assert.equal(copied.b.value, null);
});

test("two badges do not share a timer — the first one still clears", () => {
  const clock = fakeClock();
  const f = createFlasher(1500, clock);
  const copied = badge();
  const shared = badge();
  // Copy, then share inside the window. With one shared timer the copy timer was
  // cancelled and its replacement only reset `shared`, so "Copied ✓" stayed lit
  // for the rest of the card's life.
  f.show("copied", copied.set, "post");
  f.show("shared", shared.set, "mastodon");
  clock.run();
  assert.equal(copied.b.value, null);
  assert.equal(shared.b.value, null);
});

test("pressing the same button twice replaces its timer rather than stacking", () => {
  const clock = fakeClock();
  const f = createFlasher(1500, clock);
  const copied = badge();
  f.show("copied", copied.set, "post");
  f.show("copied", copied.set, "md");
  assert.equal(copied.b.value, "md");
  clock.run();
  // One timer, not two: the first must not have cleared the second badge early.
  assert.equal(copied.b.value, null);
});

test("cancelAll drops the pending timers without firing them", () => {
  const clock = fakeClock();
  const f = createFlasher(1500, clock);
  const copied = badge();
  f.show("copied", copied.set, "post");
  f.cancelAll();
  clock.run();
  // Still "post": the card went away, so nothing may set state on its way out.
  assert.equal(copied.b.value, "post");
});
