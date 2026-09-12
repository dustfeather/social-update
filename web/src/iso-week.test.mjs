// The week key is the app's primary index, so a wrong range here silently
// mislabels every item on the page. Anchor points are hand-checked ISO weeks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isoWeekStart, isoWeekRange } from "./iso-week.ts";

const iso = (d) => d.toISOString().slice(0, 10);

test("a week key resolves to its Monday", () => {
  assert.equal(iso(isoWeekStart("2026-W37")), "2026-09-07");
  assert.equal(iso(isoWeekStart("2026-W01")), "2025-12-29"); // W01 starts in the prior year here
  assert.equal(iso(isoWeekStart("2026-W53")), "2026-12-28"); // 2026 is a 53-week year
});

test("the range spans Monday through Sunday", () => {
  assert.equal(isoWeekRange("2026-W37"), "Sep 7 – Sep 13");
});

test("a week straddling New Year spells out both years", () => {
  assert.equal(isoWeekRange("2026-W01"), "Dec 29, 2025 – Jan 4, 2026");
});

test("a malformed or out-of-range key renders nothing rather than Invalid Date", () => {
  for (const bad of ["", "2026-37", "2026-W00", "2026-W54", "not-a-week"]) {
    assert.equal(isoWeekStart(bad), null);
    assert.equal(isoWeekRange(bad), "");
  }
});
