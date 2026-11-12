// Software rendering and the GPU caches (src/gpu.js): kept across updates, a new version starts without the old GPU
// caches, a crash loop or software compositing switches at once.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { GPU_CACHES, startMode, clearGpuCaches, softwareComposited, createGpuWatch } = require("../src/gpu");

test("software rendering, once needed, stays across a new version", () => {
  const m = startMode({ settings: { softwareRendering: "0.5.1", lastVersion: "0.5.1" }, env: {}, version: "0.5.2" });
  assert.equal(m.software, true);
  assert.equal("softwareRendering" in m.patch, false);
  assert.equal(m.clearCaches, true);
  assert.equal(m.patch.lastVersion, "0.5.2");
});

test("the same version again: nothing cleared, nothing written", () => {
  const m = startMode({ settings: { lastVersion: "0.5.2" }, env: {}, version: "0.5.2" });
  assert.deepEqual(m, { software: false, clearCaches: false, patch: {} });
});

test("a first start (no lastVersion yet) counts as a new version", () => {
  assert.equal(startMode({ settings: {}, env: {}, version: "0.5.2" }).clearCaches, true);
});

test("HRH_DISABLE_GPU=1 forces it, =0 forgets the saved choice", () => {
  assert.equal(startMode({ settings: {}, env: { HRH_DISABLE_GPU: "1" }, version: "1" }).software, true);
  const m = startMode({ settings: { softwareRendering: true, lastVersion: "1" }, env: { HRH_DISABLE_GPU: "0" }, version: "1" });
  assert.equal(m.software, false);
  assert.ok("softwareRendering" in m.patch && m.patch.softwareRendering === undefined);
});

test("the GPU caches go from userData; one that can't be removed is reported", () => {
  const seen = [];
  const failed = clearGpuCaches("/data", {
    rm: (p, o) => {
      seen.push([p, o.recursive, o.force]);
      if (p.endsWith("ShaderCache") && !p.endsWith("GrShaderCache")) throw new Error("busy");
    },
  });
  assert.deepEqual(seen.map((x) => x[0]), GPU_CACHES.map((n) => path.join("/data", n)));
  assert.ok(seen.every((x) => x[1] && x[2]));
  assert.deepEqual(failed, ["ShaderCache"]);
  for (const n of ["GPUCache", "ShaderCache", "GrShaderCache", "DawnGraphiteCache", "DawnWebGPUCache"]) assert.ok(GPU_CACHES.includes(n));
});

test("3 GPU crashes within 2 minutes switch; spread out, they don't", () => {
  let now = 0;
  const watch = createGpuWatch({ now: () => now });
  const crash = { type: "GPU", reason: "crashed" };
  assert.equal(watch(crash, {}), false);
  now += 50_000;
  assert.equal(watch(crash, {}), false);
  now += 50_000;
  assert.equal(watch(crash, {}), true);
  const slow = createGpuWatch({ now: () => now });
  for (let i = 0; i < 5; i++) {
    now += 130_000;
    assert.equal(slow(crash, {}), false);
  }
});

test("software compositing after one crash switches at once; other processes and clean exits never do", () => {
  const watch = createGpuWatch();
  assert.equal(watch({ type: "GPU", reason: "clean-exit" }, { gpu_compositing: "disabled_software" }), false);
  assert.equal(watch({ type: "Utility", reason: "crashed" }, { gpu_compositing: "disabled_software" }), false);
  assert.equal(watch({ type: "GPU", reason: "crashed" }, { gpu_compositing: "enabled" }), false);
  assert.equal(watch({ type: "GPU", reason: "launch-failed" }, { gpu_compositing: "unavailable_software" }), true);
  assert.equal(softwareComposited({ gpu_compositing: "disabled_software" }), true);
  assert.equal(softwareComposited({ gpu_compositing: "enabled" }), false);
  assert.equal(softwareComposited(null), false);
});
