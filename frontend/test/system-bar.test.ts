// The usage bar's pure parts (src/lib/systemBar.ts): units, load levels, what fits a width, the last minute's line.
// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { applySample, gb, level, pct, rate, roomFor, useSystemBar, HISTORY, type BarSample } from "../src/lib/systemBar.ts";

test("units and levels", () => {
  assert.equal(gb(8.7 * 1024 ** 3), "8.7");
  assert.equal(gb(128 * 1024 ** 3), "128");
  assert.equal(gb(null), "–");
  assert.equal(pct(3, 12), 25);
  assert.equal(pct(3, 0), null);
  assert.equal(rate(512), "512 B/s");
  assert.equal(rate(20 * 1024), "20 KB/s");
  assert.equal(rate(3.5 * 1024 ** 2), "3.5 MB/s");
  assert.deepEqual([null, 10, 74.9, 75, 89.9, 90, 100].map(level), ["ok", "ok", "ok", "warn", "warn", "high", "high"]);
});

test("what fits a width", () => {
  assert.deepEqual([380, 459, 460, 759, 760, 999, 1000, 1600].map(roomFor),
    ["narrow", "narrow", "medium", "medium", "normal", "normal", "wide", "wide"]);
});

test("samples keep the last minute of CPU and GPU load", () => {
  const s = (cpu: number, util: number): BarSample => ({
    ts: 0, interval: 2, host: "h", cpu, cores: 4, mem: [1, 2], swap: null,
    gpus: [{ name: "G", util, mem: [1, 2], temp: 40, power: 10 }], net: [0, 0], geny: null, alerts: 0,
  });
  for (let i = 0; i < HISTORY + 5; i++) applySample(s(i, 100 - i));
  const st = useSystemBar.getState();
  assert.equal(st.status, "live");
  assert.equal(st.cpuHist.length, HISTORY);
  assert.equal(st.cpuHist.at(-1), HISTORY + 4);
  assert.equal(st.gpuHist[0].length, HISTORY);
  assert.equal(st.last?.cpu, HISTORY + 4);
});
