// The Android app's side of updates, in a real browser against a real server (its Download service reading the real
// apps-latest): a phone with a stand-in for the Capacitor bridge — App.getInfo answers late (as the native bridge
// may), GenyServer.downloadApk / downloadStatus / installApk record their calls and report a download whose bytes
// really come from the server's APK URL. Checks: Settings → Updates shows the app's own version (not 0.0.0) and the
// newer build; the Download page fetches the APK through the plugin with progress, then Install opens the installer
// (first: the "allow installs from this app" settings, then the installer itself). What the plugin does on a device
// (DownloadManager, the installer intent) is NOT covered here.
//
//   NODE_PATH=<dir with playwright-core> CHROME=<chrome binary> SHOTS=<dir> \
//     node test/e2e/apk-update-browser.js <server url> <password> <app version, e.g. 0.4.14>
"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright-core");

const [SERVER, PASSWORD, APP_VERSION] = process.argv.slice(2);
if (!SERVER || !PASSWORD || !APP_VERSION) {
  console.error("usage: node test/e2e/apk-update-browser.js <server url> <password> <app version>");
  process.exit(2);
}
const SHOTS = process.env.SHOTS || path.join(os.homedir(), ".cache", "hrh-apk-update-shots");
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`• ${s}`);
async function until(what, fn, ms = 20000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

// in the page, before its scripts: Capacitor as the Android app has it (only what the console calls)
const FAKE_CAPACITOR = (version) => {
  const calls = (window.__capCalls = []);
  // the system download outlives the page (DownloadManager): kept in localStorage, its progress by the clock
  const KEY = "__fakeDownload";
  const load = () => JSON.parse(localStorage.getItem(KEY) || "null");
  let installs = 0;
  window.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "android",
    nativeCallback: () => "cb",
    nativePromise: async (plugin, method, opts = {}) => {
      calls.push({ plugin, method, opts });
      if (plugin === "App" && method === "getInfo") {
        await new Promise((r) => setTimeout(r, 600)); // (after the first render)
        return { version, build: "1", id: "me.hrletsgo.harnessor", name: "My Mate Geny" };
      }
      if (plugin !== "GenyServer") return {};
      if (method === "downloadApk") {
        // the bytes really come from the server (same cookie as the app's DownloadManager request)
        const r = await fetch(opts.url, { credentials: "include" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const total = (await r.arrayBuffer()).byteLength;
        localStorage.setItem(KEY, JSON.stringify({ id: 7, total, at: Date.now() }));
        return { id: 7 };
      }
      if (method === "downloadStatus") {
        const dl = load();
        if (!dl || opts.id !== dl.id) return { status: "gone" };
        const transferred = Math.min(dl.total, Math.round(((Date.now() - dl.at) / 8000) * dl.total)); // (8 s, a phone's pace)
        return { status: transferred >= dl.total ? "done" : "running", transferred, total: dl.total };
      }
      if (method === "installApk") {
        installs++;
        return installs === 1 ? { needsPermission: true } : {};
      }
      if (method === "cancelDownload") return localStorage.removeItem(KEY), {};
      return {};
    },
  };
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME });
  const failures = [];
  try {
    const ctx = await browser.newContext({
      viewport: { width: 412, height: 915 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
    });
    const r = await ctx.request.post(`${SERVER}/api/auth/login`, { data: { username: "admin", password: PASSWORD } });
    assert.ok(r.ok(), "login");
    await ctx.addInitScript(() => localStorage.setItem("hrh_lang", "en"));
    await ctx.addInitScript(FAKE_CAPACITOR, APP_VERSION);
    const page = await ctx.newPage();
    const rel = await (await ctx.request.get(`${SERVER}/api/downloads`)).json();
    const apk = rel.assets.find((a) => a.platform === "android");
    console.log(`  the server offers ${rel.version}: ${apk && apk.name}`);

    step("Settings → Updates: the Android app's own version and the newer build");
    await page.goto(`${SERVER}/?view=settings`);
    const row = page.locator('[data-testid="settings-app-update"]');
    await row.waitFor({ timeout: 20000 });
    const text = await until("the version and the release", async () => {
      const t = (await row.innerText()).replace(/\s+/g, " ");
      return /available|up to date|latest/i.test(t) ? t : null;
    }, 20000);
    console.log(`  ${text}`);
    if (!text.includes(APP_VERSION)) failures.push(`Settings shows the app as: ${text}`);
    if (/0\.0\.0/.test(text)) failures.push("Settings shows version 0.0.0");
    if (!new RegExp(`${rel.version.replace(/\./g, "\\.")} is available`).test(text)) failures.push(`no "${rel.version} available": ${text}`);
    await row.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS, "android-settings.png") });

    step("Update on the Download page → the APK through the app's DownloadManager, with progress");
    await page.locator('[data-testid="settings-open-downloads"]').click();
    const btn = page.locator('[data-testid="asset-android-apk"]').first();
    await btn.waitFor({ timeout: 20000 });
    await btn.click();
    const prog = page.locator('[data-testid="download-progress"]');
    await prog.waitFor({ timeout: 20000 });
    const mid = await until("progress with bytes", async () => {
      const t = (await prog.innerText()).replace(/\s+/g, " ");
      return /MB of/.test(t) ? t : null;
    }, 60000);
    console.log(`  ${mid}`);
    await page.screenshot({ path: path.join(SHOTS, "android-downloading.png") });
    const calls = await page.evaluate(() => window.__capCalls.filter((c) => c.plugin === "GenyServer" && c.method === "downloadApk"));
    if (calls.length !== 1 || !calls[0].opts.url.startsWith(SERVER) || !calls[0].opts.url.includes(apk.name)) failures.push(`downloadApk called with ${JSON.stringify(calls)}`);

    step("a reload in the middle: the same download is shown again (its id kept)");
    await page.reload();
    await page.locator('[data-testid="download-progress"]').waitFor({ timeout: 20000 });

    step("done → Install: first the 'allow installs' settings, then the installer");
    const install = page.locator('[data-testid="download-install"]');
    await install.waitFor({ timeout: 120000 });
    await page.screenshot({ path: path.join(SHOTS, "android-done.png") });
    await install.click();
    await sleep(500);
    await install.click();
    await sleep(500);
    const inst = await page.evaluate(() => window.__capCalls.filter((c) => c.method === "installApk").map((c) => c.opts));
    console.log(`  installApk calls: ${JSON.stringify(inst)}`);
    if (inst.length !== 2 || inst.some((o) => o.id !== 7)) failures.push(`installApk: ${JSON.stringify(inst)}`);
  } finally {
    await browser.close();
  }
  if (failures.length) {
    console.log(`\nFAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
    process.exitCode = 1;
  } else console.log("\nall Android update steps passed");
})().catch((e) => {
  console.error(e.stack || e);
  process.exitCode = 1;
});
