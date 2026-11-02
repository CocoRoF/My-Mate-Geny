// The Relationship panel's pure parts (src/mate/relationJournal.ts): filters, the journal grouped by day, the
// chart's text alternative, the next anniversary, how a delta reads.
// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { chartSummary, deltaText, filterChanges, groupByDay, localDay, nextAnniversary } from "../src/mate/relationJournal.ts";

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).toISOString();
const changes = [
  { at: at(2026, 11, 2, 15), d: 0, why: "manual", v: 40, kind: "manual" as const },
  { at: at(2026, 11, 2, 9), d: 6, why: "talk", v: 30, kind: "gain" as const },
  { at: at(2026, 11, 1, 0), d: -4, why: "quiet_4", v: 24, kind: "loss" as const },
  { at: at(2026, 10, 30, 10), d: 0, why: "stage_up", v: null, kind: "stage" as const, stage: "familiar" as const },
];

test("filters and days", () => {
  assert.deepEqual(filterChanges(changes, "all"), changes);
  assert.deepEqual(filterChanges(changes, "gain").map((c) => c.why), ["talk"]);
  assert.deepEqual(filterChanges(changes, "stage").map((c) => c.stage), ["familiar"]);
  const g = groupByDay(changes);
  assert.deepEqual(g.map((x) => [x.day, x.items.length]), [["2026-11-02", 2], ["2026-11-01", 1], ["2026-10-30", 1]]);
  assert.equal(localDay(new Date(2026, 0, 5, 23)), "2026-01-05");
});

test("the chart's summary and the next anniversary", () => {
  const series = [
    { day: "2026-10-30", v: null, up: 0, down: 0, talks: 0 },
    { day: "2026-10-31", v: 12.4, up: 12.4, down: 0, talks: 3 },
    { day: "2026-11-01", v: 8.4, up: 0, down: -4, talks: 0 },
    { day: "2026-11-02", v: 40, up: 6, down: 0, talks: 1 },
  ];
  assert.deepEqual(chartSummary(series), { from: 12, to: 40, max: 40, min: 8, talked: 2 });
  assert.equal(chartSummary([series[0]]), null);
  const anns = [
    { days: 7, day: "2026-10-01", reached: true, in_days: 0 },
    { days: 30, day: "2026-10-24", reached: true, in_days: 0 },
    { days: 100, day: "2027-01-02", reached: false, in_days: 61 },
    { days: 365, day: "2027-09-24", reached: false, in_days: 326 },
  ];
  assert.equal(nextAnniversary(anns)?.days, 100);
  assert.equal(nextAnniversary(anns.slice(0, 2)), null);
  assert.equal(deltaText(6), "+6.0");
  assert.equal(deltaText(-4.25), "−4.3");
  assert.equal(deltaText(0), "·");
});
