// Folders on several hosts + Git on a remote host, in a browser (docs/remote.md "Folders on several hosts"):
// against a throwaway server whose SSH connections reach real hosts, with two chats set up beforehand:
//   A: workspace on an SSH host, folders on another SSH host and on this server, Git repo connected on its host
//   B: workspace on this server, folders on SSH hosts, repos cloned there (its Git gets disconnected here)
//
//   NODE_PATH=<dir with playwright-core> CHROME=<chromium binary> \
//     node test/e2e/multihost-browser.js <server url> <password> <shots dir> <chat A id> <chat B id>
//
// Checks: host chips, host badges on connected folders, ticking folders on two hosts and connecting them together,
// the Explorer listing + opening a file of a folder on another host, the Git popover of a repo on an SSH host
// (badge) and of a chat with repos on several hosts (found per host, clone onto a chosen host). Shots: en/ko ×
// light/dark on a desktop, two on a phone.
"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const [SERVER, PASSWORD, SHOTS, A, B] = process.argv.slice(2);
if (!SERVER || !PASSWORD || !SHOTS || !A || !B) {
  console.error("usage: node test/e2e/multihost-browser.js <server url> <password> <shots dir> <chat A> <chat B>");
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`• ${s}`);
const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
};

async function api(ctx, method, url, body) {
  const r = await ctx.request.fetch(SERVER + url, { method, data: body, headers: { "Content-Type": "application/json" } });
  const t = await r.text();
  if (!r.ok()) throw new Error(`${method} ${url}: ${r.status()} ${t}`);
  return t ? JSON.parse(t) : null;
}

async function context(browser, { lang, theme, phone }) {
  const ctx = await browser.newContext({ ...(phone ? PHONE : { viewport: { width: 1440, height: 900 } }), colorScheme: theme });
  const r = await ctx.request.post(SERVER + "/api/auth/login", { data: { username: "admin", password: PASSWORD } });
  assert.ok(r.ok(), "login");
  await ctx.request.put(SERVER + "/api/preferences", { data: { language: null } }).catch(() => {});
  await ctx.addInitScript(
    ([l, th]) => {
      localStorage.setItem("hrh_lang", l);
      localStorage.setItem("hrh_theme", th);
      localStorage.setItem("hrh_session_panel", "0");
    },
    [lang, theme],
  );
  return ctx;
}

async function open(ctx, sid) {
  await ctx.addInitScript((id) => localStorage.setItem("hrh_last_session", id), sid);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await page.goto(SERVER + "/");
  await page.waitForSelector('[data-testid="topbar-folders"]', { timeout: 20000 });
  await sleep(600);
  return page;
}

const shot = async (page, name) => {
  await sleep(450); // (popovers fade in)
  await page.screenshot({ path: path.join(SHOTS, name) });
};

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
  const setup = await context(browser, { lang: "en", theme: "dark" });
  const a = await api(setup, "GET", `/api/sessions/${A}`);
  const conns = await api(setup, "GET", "/api/connections");
  const hosts = await api(setup, "GET", "/api/connections/hosts");
  const self = hosts.filter((h) => h.this_host && h.id).map((h) => h.id);
  const other = a.folders.find((f) => f.connection_id && f.connection_id !== a.connection_id);
  assert.ok(other, "chat A has a folder on another SSH host");
  const otherName = conns.find((c) => c.id === other.connection_id).name;
  await api(setup, "DELETE", `/api/sessions/${B}/git`); // B: not connected → repos found on its hosts + clone
  await setup.close();

  let first = true;
  for (const [lang, theme] of [["en", "dark"], ["en", "light"], ["ko", "dark"], ["ko", "light"]]) {
    const tag = `${lang}-${theme}`;
    step(`desktop ${tag}`);
    const ctx = await context(browser, { lang, theme });
    const page = await open(ctx, A);

    // the Folder popover: connected folders with their hosts
    await page.click('[data-testid="topbar-folders"]');
    await page.waitForSelector('[data-testid="folders-connected"] li');
    const badges = await page.$$eval('[data-testid="folders-connected"] [data-testid="folder-host-badge"]', (els) => els.map((e) => e.textContent));
    assert.ok(badges.includes(otherName), `the other host's badge (${badges})`);
    assert.equal(badges.length, a.folders.length);
    // (which connections are this machine arrives with /api/connections/hosts — probed once, then cached)
    await page.waitForFunction(
      (ids) => ![...document.querySelectorAll('[data-testid="folders-hosts"] [data-host]')].some((e) => ids.includes(e.getAttribute("data-host"))),
      self,
      { timeout: 20000 },
    );
    const chips = await page.$$eval('[data-testid="folders-hosts"] [data-host]', (els) => els.map((e) => e.getAttribute("data-host")));
    for (const id of self) assert.ok(!chips.includes(id), "a connection that is this machine is folded into 'this server'");
    assert.ok(chips.includes("local") && chips.includes(other.connection_id), `chips: ${chips}`);
    await shot(page, `folders-connected-${tag}.png`);

    // tick folders on two hosts, then connect them together (once), else just show the tray
    await page.click(`[data-testid="folders-hosts"] [data-host="${other.connection_id}"]`);
    await page.waitForSelector('[data-testid="folders-suggestions"] [data-testid="folders-tick"]', { timeout: 20000 });
    await page.click('[data-testid="folders-suggestions"] li:nth-child(2) [data-testid="folders-tick"]');
    await page.click('[data-testid="folders-hosts"] [data-host="local"]');
    await page.waitForSelector('[data-testid="folders-suggestions"] [data-testid="folders-tick"]', { timeout: 20000 });
    await page.click('[data-testid="folders-suggestions"] li:nth-child(2) [data-testid="folders-tick"]');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="folders-picked"] .pill').length === 2);
    await shot(page, `folders-multi-select-${tag}.png`);
    if (first) {
      const before = (await api(ctx, "GET", `/api/sessions/${A}`)).folders.length;
      await page.click('[data-testid="folders-connect-picked"]');
      await page.waitForFunction((n) => document.querySelectorAll('[data-testid="folders-connected"] li').length === n + 2, before, { timeout: 30000 });
      const after = (await api(ctx, "GET", `/api/sessions/${A}`)).folders;
      assert.equal(after.length, before + 2, "two folders on two hosts connected together");
      assert.ok(after.slice(-2).some((f) => f.connection_id === other.connection_id) && after.slice(-2).some((f) => !f.connection_id));
      await shot(page, `folders-connected-two-hosts-${tag}.png`);
      await api(ctx, "PATCH", `/api/sessions/${A}`, { folders: after.slice(0, before) }); // back as it was
      first = false;
    }
    await page.keyboard.press("Escape");

    // the Explorer: the other host's folder is a root with its badge; open its hello.txt
    await page.reload();
    await page.waitForSelector('[data-topbar-item="explorer"]');
    await page.click('[data-topbar-item="explorer"]');
    await page.waitForSelector('[data-testid="explorer-root-host"]', { timeout: 20000 });
    const key = `@${other.connection_id}:${other.path}/hello.txt`;
    await page.waitForSelector(`[data-path="${key}"]`, { timeout: 30000 });
    await page.click(`[data-path="${key}"]`);
    await page.waitForSelector('[data-testid="viewer-host-badge"]', { timeout: 30000 });
    await page.waitForFunction(
      () => [...document.querySelectorAll("main *, [role=tabpanel] *, div")].some(
        (e) => e.children.length === 0 && /^hello from .+\(srv-\d+\)$/.test((e.textContent || "").trim()) && e.offsetParent !== null),
      null,
      { timeout: 30000 },
    );
    await sleep(300);
    await shot(page, `explorer-remote-file-${tag}.png`);

    // Git: A's repo is on its SSH host (badge)
    await page.click('[data-testid="topbar-git"]');
    await page.waitForSelector('[data-testid="git-popover"] [data-testid="git-host-badge"]', { timeout: 30000 });
    await shot(page, `git-remote-connected-${tag}.png`);
    await page.close();

    // Git: B (workspace here) — repos found on two SSH hosts, clone onto a chosen host
    const pb = await open(ctx, B);
    await pb.click('[data-testid="topbar-git"]');
    await pb.waitForSelector('[data-testid="git-found"] li', { timeout: 30000 });
    const found = await pb.$$eval('[data-testid="git-found"] [data-testid="git-host-badge"]', (els) => els.map((e) => e.textContent));
    assert.ok(new Set(found).size >= 2, `repos on two hosts (${found})`);
    const options = await pb.$$eval('[data-testid="git-clone-host"] option', (els) => els.map((e) => e.value));
    assert.ok(options.includes(other.connection_id) && options.includes("local"));
    await pb.selectOption('[data-testid="git-clone-host"]', other.connection_id);
    await pb.selectOption('[data-testid="git-clone-source"]', "url");
    await pb.fill('[data-testid="git-clone-url"]', "https://github.com/octocat/Hello-World.git");
    await shot(pb, `git-clone-remote-${tag}.png`);
    await ctx.close();
  }

  for (const [lang, theme] of [["en", "dark"], ["ko", "light"]]) {
    const tag = `phone-${lang}-${theme}`;
    step(tag);
    const ctx = await context(browser, { lang, theme, phone: true });
    const page = await open(ctx, A);
    await page.click('[data-testid="topbar-folders"]');
    await page.waitForSelector('[data-testid="folders-connected"] li');
    const box = await page.$eval('[data-testid="folders-popover"]', (e) => e.getBoundingClientRect().width);
    assert.ok(box <= 390, "the popover fits the phone");
    await shot(page, `folders-${tag}.png`);
    await page.keyboard.press("Escape");
    const pb = await open(ctx, B);
    await pb.click('[data-testid="topbar-git"]');
    await pb.waitForSelector('[data-testid="git-clone"]', { timeout: 30000 });
    await shot(pb, `git-${tag}.png`);
    await ctx.close();
  }
  await browser.close();
  console.log("multihost browser: all checks passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
