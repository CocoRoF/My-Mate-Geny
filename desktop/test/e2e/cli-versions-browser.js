// Settings → Providers → CLI versions in a browser, against a throwaway backend on THIS machine whose CODEX_BINARY
// is an older @openai/codex installed into a temp npm prefix (never the CLIs in use) and whose CLAUDE_BINARY is
// fake-claude (with FAKE_MD_PAUSE so an "md1" reply keeps a chat running for a while):
//
//   NODE_PATH=<dir with playwright-core> CHROME=<chromium binary> \
//     node test/e2e/cli-versions-browser.js <server url> <password> <workspace dir> [shots dir]
//
// The section (installed vs latest, the Settings badge only for a real newer version), "Check now", bad input and a
// failing upgrade (a version npm doesn't have) with its log and Retry, "upgrade when idle" waiting for a running chat
// (cancel, then again until the chat ends), the upgrade's log streaming in (pushed, no polling), the verified result
// and the badge going away, a roll back; English and Korean, light and dark.
"use strict";
const assert = require("assert/strict");
const path = require("path");
const { chromium } = require("playwright-core");

const [SERVER, PASSWORD, WS, SHOTS] = process.argv.slice(2);
if (!SERVER || !PASSWORD || !WS) {
  console.error("usage: node test/e2e/cli-versions-browser.js <server url> <password> <workspace dir> [shots dir]");
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`• ${s}`);

async function device(browser, { lang = "en", theme = "light" } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, colorScheme: theme });
  const r = await ctx.request.post(SERVER + "/api/auth/login", { data: { username: "admin", password: PASSWORD } });
  assert.ok(r.ok(), "login");
  await ctx.addInitScript(
    ([l, th]) => {
      try {
        localStorage.setItem("hrh_lang", l);
        localStorage.setItem("hrh_theme", th);
      } catch {}
    },
    [lang, theme],
  );
  return ctx;
}

async function api(ctx, method, url, body) {
  const r = await ctx.request.fetch(SERVER + url, { method, data: body, headers: { "Content-Type": "application/json" } });
  const t = await r.text();
  if (!r.ok()) throw new Error(`${method} ${url}: ${r.status()} ${t}`);
  return t ? JSON.parse(t) : null;
}

async function shot(page, name, locator) {
  if (!SHOTS) return;
  const file = path.join(SHOTS, name);
  if (locator) await locator.screenshot({ path: file });
  else await page.screenshot({ path: file, fullPage: false });
  console.log(`  shot: ${file}`);
}

async function providers(ctx, { trackRequests = false } = {}) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  const reqs = [];
  if (trackRequests) page.on("request", (r) => r.url().includes("/api/cli-tools") && reqs.push({ at: Date.now(), url: r.url(), method: r.method() }));
  await page.goto(SERVER + "/?view=settings&tab=providers");
  await page.waitForSelector('[data-testid="cli-tool-codex"]', { timeout: 30000 });
  // the first status kicks off the registry lookup: wait for "latest" to arrive (pushed: cli.changed)
  await page.waitForFunction(() => !document.querySelector('[data-testid="cli-check-now"]')?.hasAttribute("disabled"), null, { timeout: 30000 });
  await page.locator('[data-testid="cli-versions"]').scrollIntoViewIfNeeded();
  return { page, reqs };
}

const text = (page, id) => page.locator(`[data-testid="${id}"]`).innerText();
const jobState = (page, tool) => page.locator(`[data-testid="cli-job-${tool}"]`).getAttribute("data-state").catch(() => null);
const jobId = (page, tool) => page.locator(`[data-testid="cli-job-${tool}"]`).getAttribute("data-job").catch(() => null);
/** click a button that starts an upgrade: the new job's id (from the API's answer) */
async function startJob(page, selector) {
  const [resp] = await Promise.all([
    page.waitForResponse((r) => /\/api\/cli-tools\/\w+\/upgrade$/.test(r.url()) && r.request().method() === "POST"),
    page.click(selector),
  ]);
  const body = await resp.json();
  assert.ok(resp.ok(), `upgrade refused: ${JSON.stringify(body)}`);
  return body.id;
}
/** the job on screen reaches one of `want` (and is `id`, when given — not the one before it) */
async function waitState(page, tool, want, timeout = 60000, id = null) {
  const t0 = Date.now();
  for (;;) {
    const s = id && (await jobId(page, tool)) !== id ? null : await jobState(page, tool);
    if (want.includes(s)) return s;
    if (Date.now() - t0 > timeout) throw new Error(`job ${tool}: ${s}, wanted ${want}`);
    await sleep(100);
  }
}

async function startLongChat(ctx) {
  const s = await api(ctx, "POST", "/api/sessions", { provider: "claude", model: "", connection_id: null, workspace_path: WS, title: `cli-e2e ${Date.now().toString(36)}` });
  await ctx.addInitScript((id) => localStorage.setItem("hrh_last_session", id), s.id);
  const page = await ctx.newPage();
  await page.goto(SERVER + "/");
  await page.waitForSelector("textarea", { timeout: 20000 });
  await sleep(1500);
  await page.fill("textarea", "md1");
  await page.click('button[title="Send"], button[title="Send (Enter)"], button[title="보내기"], button[title="보내기 (Enter)"]');
  // running = the server's active runs (what "when idle" waits for)
  for (let i = 0; i < 100; i++) {
    const st = await api(ctx, "GET", "/api/cli-tools");
    if (st.running_chats > 0) return { page, sid: s.id };
    await sleep(100);
  }
  throw new Error("the chat never started running");
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
  try {
    const en = await device(browser, { lang: "en", theme: "light" });
    // a connected provider, so the Settings badge can only be about CLI versions (lib/attention.ts)
    await api(en, "POST", "/api/providers/claude/connect", { auth_mode: "api_key", api_key: "sk-ant-e2e-fake" });
    let st0 = await api(en, "POST", "/api/cli-tools/check", {});
    for (let i = 0; i < 600 && st0.tools.some((t) => t.job?.active); i++) {
      await sleep(200); // (a job left by an earlier run)
      st0 = await api(en, "GET", "/api/cli-tools");
    }
    if (!st0.tools.find((t) => t.id === "codex").update_available) {
      // an earlier run left the temp-prefix codex upgraded: back to the old one first (through the API: a pin)
      const old = process.env.CODEX_OLD || "0.165.0";
      step(`(re-run: pinning the temp-prefix codex back to ${old})`);
      await api(en, "POST", "/api/cli-tools/codex/upgrade", { version: old });
      for (let i = 0; i < 600; i++) {
        await sleep(200);
        st0 = await api(en, "GET", "/api/cli-tools");
        if (!st0.tools.find((t) => t.id === "codex").job?.active) break;
      }
      st0 = await api(en, "POST", "/api/cli-tools/check", {});
    }
    const codex0 = st0.tools.find((t) => t.id === "codex");
    step(`codex ${codex0.installed.version} (${codex0.installed.method}) at ${codex0.installed.path}; latest ${codex0.latest.version}`);
    assert.equal(codex0.installed.method, "npm");
    assert.ok(codex0.update_available, "the temp-prefix codex is older than the registry's latest");
    for (const t of st0.tools) assert.ok(!t.job?.active, `${t.id}: no job left running`);

    step("the section: installed vs latest, the badge only for a real newer version");
    const { page, reqs } = await providers(en, { trackRequests: true });
    assert.match(await text(page, "cli-installed-codex"), new RegExp(codex0.installed.version.replace(/\./g, "\\.")));
    assert.equal(await text(page, "cli-pill-codex"), "Update available");
    assert.equal(await text(page, "cli-pill-higgsfield"), st0.tools.find((t) => t.id === "higgsfield").update_available ? "Update available" : "Up to date");
    const claude0 = st0.tools.find((t) => t.id === "claude");
    assert.equal(claude0.update_available, false, "the e2e Claude wrapper reports the latest version");
    assert.equal(await page.locator('[data-testid="nav-settings-badge"]').count(), 0, "an update is no warning, and nothing outside Settings");
    assert.equal(await page.locator('[data-testid="settings-tab-providers"] [data-testid="settings-tab-badge"]').count(), 0);
    assert.equal(await page.locator('[data-testid="settings-tab-providers"] [data-testid="settings-tab-update"]').getAttribute("title"), "A CLI update is available");
    await shot(page, "en-light-1-section.png", page.locator('[data-testid="cli-versions"]'));

    step("Check now");
    await page.click('[data-testid="cli-check-now"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="cli-check-now"]')?.hasAttribute("disabled"), null, { timeout: 30000 });
    assert.match(await page.locator('[data-testid="cli-versions"]').innerText(), /checked (just now|\d+s ago)/);

    step("what's new: the release notes summary");
    await page.locator('[data-testid="cli-tool-codex"] [data-testid="cli-notes-toggle"]').click();
    await shot(page, "en-light-2-notes.png", page.locator('[data-testid="cli-tool-codex"]'));
    await page.locator('[data-testid="cli-tool-codex"] [data-testid="cli-notes-toggle"]').click();

    step("errors: a bad version is refused; a version npm doesn't have fails with its log and Retry");
    await page.click('[data-testid="cli-more-codex"]');
    await page.fill('[data-testid="cli-pin-codex"]', "abc");
    await page.click('[data-testid="cli-pin-install-codex"]');
    await page.click('[data-testid="cli-confirm-now-codex"]');
    await page.waitForSelector('[data-testid="cli-error-codex"]');
    assert.equal(await text(page, "cli-error-codex"), "Give a version like 1.2.3.");
    await page.fill('[data-testid="cli-pin-codex"]', "0.0.1");
    await page.click('[data-testid="cli-pin-install-codex"]');
    const bad = await startJob(page, '[data-testid="cli-confirm-now-codex"]');
    await waitState(page, "codex", ["failed"], 120000, bad);
    assert.match(await text(page, "cli-job-line-codex"), /failed: the updater failed/);
    assert.match(await text(page, "cli-log-codex"), /npm (error|ERR)/);
    assert.equal(await page.locator('[data-testid="cli-retry-codex"]').count(), 1);
    await shot(page, "en-light-3-failed.png", page.locator('[data-testid="cli-tool-codex"]'));
    await page.click('[data-testid="cli-more-codex"]');

    step("upgrade while a chat runs: the warning, “When idle” → waiting; Don't wait → cancelled");
    const chat = await startLongChat(await device(browser, { lang: "en" }));
    await page.click('[data-testid="cli-upgrade-codex"]');
    await page.waitForSelector('[data-testid="cli-running-warn-codex"]', { timeout: 10000 });
    assert.match(await text(page, "cli-running-warn-codex"), /1 chat is running/);
    await shot(page, "en-light-4-confirm-running.png", page.locator('[data-testid="cli-tool-codex"]'));
    const w1 = await startJob(page, '[data-testid="cli-confirm-idle-codex"]');
    await waitState(page, "codex", ["waiting"], 60000, w1);
    assert.match(await text(page, "cli-job-line-codex"), /Waiting for 1 running chat to finish/);
    assert.equal(await page.locator('[data-testid="settings-tab-update"]').count(), 0, "no dot while an upgrade waits");
    await shot(page, "en-light-5-waiting.png", page.locator('[data-testid="cli-tool-codex"]'));
    await page.click('[data-testid="cli-cancel-codex"]');
    await waitState(page, "codex", ["cancelled"]);

    step("…again, and this time wait: the chat ends → the upgrade runs, its log streams in, verified");
    await page.click('[data-testid="cli-upgrade-codex"]');
    const w2 = await startJob(page, '[data-testid="cli-confirm-idle-codex"]');
    await waitState(page, "codex", ["waiting"], 60000, w2);
    const before = reqs.length;
    const t0 = Date.now();
    const st = await waitState(page, "codex", ["running", "verifying", "succeeded"], 120000);
    step(`  the chat ended; the job is ${st} after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    let midLog = 0;
    for (let i = 0; i < 200 && (await jobState(page, "codex")) === "running"; i++) {
      midLog = Math.max(midLog, (await text(page, "cli-log-codex").catch(() => "")).split("\n").length);
      if (midLog >= 3 && i % 5 === 0) await shot(page, "en-light-6-running.png", page.locator('[data-testid="cli-tool-codex"]'));
      await sleep(50);
    }
    await waitState(page, "codex", ["succeeded"], 120000);
    const log = await text(page, "cli-log-codex");
    assert.match(log, /\$ .*npm install --global --prefix .* @openai\/codex@/);
    assert.match(log, /--version → codex-cli /);
    assert.match(await text(page, "cli-job-line-codex"), /Upgraded .* → .* in [\d.]+ s/);
    assert.equal(await text(page, "cli-pill-codex"), "Up to date");
    // no polling: the status was refetched only after pushes (a handful of requests over the whole run)
    const during = reqs.slice(before);
    const span = (Date.now() - t0) / 1000;
    step(`  ${during.length} GET /api/cli-tools over ${span.toFixed(1)} s (pushed changes only), log lines seen mid-run: ${midLog}`);
    assert.ok(during.length <= 12, `too many status fetches: ${during.length}`);
    await page.waitForFunction(() => !document.querySelector('[data-testid="settings-tab-update"]'), null, { timeout: 10000 });
    await shot(page, "en-light-7-succeeded.png", page.locator('[data-testid="cli-tool-codex"]'));
    const st1 = await api(en, "GET", "/api/cli-tools");
    const codex1 = st1.tools.find((t) => t.id === "codex");
    assert.equal(codex1.installed.version, codex0.latest.version);
    assert.equal(codex1.previous_version, codex0.installed.version);
    await chat.page.context().close();

    step("dark / Korean");
    for (const [lang, theme] of [["en", "dark"], ["ko", "light"], ["ko", "dark"]]) {
      const ctx = await device(browser, { lang, theme });
      const { page: p } = await providers(ctx);
      await shot(p, `${lang}-${theme}-section.png`, p.locator('[data-testid="cli-versions"]'));
      if (lang === "ko" && theme === "dark") {
        await p.click('[data-testid="cli-more-codex"]');
        await shot(p, "ko-dark-more-options.png", p.locator('[data-testid="cli-tool-codex"]'));
        assert.match(await p.locator('[data-testid="cli-tool-codex"]').innerText(), /으로 되돌리기|로 되돌리기/);
      }
      await ctx.close();
    }

    step("roll back to the previous version (pin) → the update is offered again, with the badge");
    await page.click('[data-testid="cli-more-codex"]');
    await page.click('[data-testid="cli-rollback-codex"]');
    const rb = await startJob(page, '[data-testid="cli-confirm-now-codex"]');
    await waitState(page, "codex", ["succeeded", "failed"], 120000, rb);
    assert.equal(await jobState(page, "codex"), "succeeded");
    assert.equal(await text(page, "cli-pill-codex"), "Update available");
    await page.waitForSelector('[data-testid="settings-tab-update"]', { timeout: 10000 });
    const st2 = await api(en, "GET", "/api/cli-tools");
    assert.equal(st2.tools.find((t) => t.id === "codex").installed.version, codex0.installed.version);

    step("Korean: the confirm panel");
    const ko = await device(browser, { lang: "ko", theme: "light" });
    const { page: pk } = await providers(ko);
    await pk.click('[data-testid="cli-upgrade-codex"]');
    await pk.waitForSelector('[data-testid="cli-confirm-codex"]');
    assert.match(await text(pk, "cli-confirm-codex"), /업그레이드할까요/);
    await shot(pk, "ko-light-confirm.png", pk.locator('[data-testid="cli-tool-codex"]'));
    console.log("ok");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
