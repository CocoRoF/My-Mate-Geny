// Software rendering and Chromium's GPU caches: what main.js decides before the app is ready, and when a running app
// switches.
//
// Software rendering is SwiftShader (the GPU's work done on the CPU), not disableHardwareAcceleration(): on Windows that
// turned the transparent Mate windows black and took WebGL away, so her videos fell back to stills. Once a machine
// needed it, it keeps it — across updates too: a new version used to try the GPU again, and on a machine whose GPU path
// fails Chromium then gave up on the GPU mid-session and composited in software, which draws the transparent windows
// (avatar, bar, quick card) black until the next start. HRH_DISABLE_GPU=1 forces it; HRH_DISABLE_GPU=0 forgets the
// saved choice and tries the GPU again.
"use strict";

const fs = require("fs");
const path = require("path");

/** Chromium's GPU caches in userData: shaders and pipelines built by the previous version (or driver) can be what
 *  crashes the GPU process of the next one — the first start of a new version begins without them */
const GPU_CACHES = ["GPUCache", "ShaderCache", "GrShaderCache", "DawnGraphiteCache", "DawnWebGPUCache"];

/** the start: software rendering or not, whether the GPU caches go (a new version), and what settings.json gets */
function startMode({ settings = {}, env = {}, version = "" }) {
  const patch = {};
  const forget = env.HRH_DISABLE_GPU === "0" && !!settings.softwareRendering;
  if (forget) patch.softwareRendering = undefined;
  const software = env.HRH_DISABLE_GPU === "1" || (!forget && !!settings.softwareRendering);
  const newVersion = settings.lastVersion !== version;
  if (newVersion) patch.lastVersion = version;
  return { software, clearCaches: newVersion, patch };
}

/** removes the GPU caches from `userData` (missing ones are fine); → the names it could not remove */
function clearGpuCaches(userData, { rm = fs.rmSync } = {}) {
  const failed = [];
  for (const name of GPU_CACHES) {
    try {
      rm(path.join(userData, name), { recursive: true, force: true });
    } catch {
      failed.push(name);
    }
  }
  return failed;
}

/** Chromium composites in software for the rest of this session (app.getGPUFeatureStatus()): the GPU is given up on */
const softwareComposited = (status) => /^(disabled|unavailable)_software/.test(String(status?.gpu_compositing || ""));

/** GPU process exits → true when the app should switch to software rendering now: 3 crashes within 2 minutes, or
 *  Chromium already gave up on the GPU (software compositing: black transparent windows) */
function createGpuWatch({ now = Date.now, limit = 3, within = 120_000 } = {}) {
  let crashes = [];
  return (details, status) => {
    if (details?.type !== "GPU" || details.reason === "clean-exit") return false;
    const t = now();
    crashes = [...crashes.filter((x) => t - x < within), t];
    return crashes.length >= limit || softwareComposited(status);
  };
}

module.exports = { GPU_CACHES, startMode, clearGpuCaches, softwareComposited, createGpuWatch };
