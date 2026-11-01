// The chat's top bar — Folder and Git buttons — checked in a browser against a real server on THIS machine (backend
// with CLAUDE_BINARY=desktop/test/e2e/fake-claude.py, frontend build as STATIC_DIR):
//
//   NODE_PATH=<dir with playwright-core> CHROME=<chromium binary> \
//     node test/e2e/topbar-browser.js <server url> <password> <fixtures dir> [shots dir] [folder|git|layout]
//
// The fixtures dir is (re)created: a workspace repo with changes, an origin, a second branch, sibling folders and a
// "computer" folder to upload. Desktop (1440×900) and phone (390×844, touch) widths.
"use strict";
const assert = require("assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const [SERVER, PASSWORD, FIX, SHOTS, ONLY] = process.argv.slice(2);
if (!SERVER || !PASSWORD || !FIX) {
  console.error("usage: node test/e2e/topbar-browser.js <server url> <password> <fixtures dir> [shots dir] [folder|git|layout]");
  process.exit(2);
}
const WS = path.join(FIX, "ws");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`• ${s}`);

function fixtures() {
  fs.rmSync(FIX, { recursive: true, force: true });
  const sh = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@example.com", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@example.com" } });
  const w = (f, data) => (fs.mkdirSync(path.dirname(f), { recursive: true }), fs.writeFileSync(f, data));
  for (const d of ["shared-lib/src", "docs", "notebooks", "plain-folder"]) fs.mkdirSync(path.join(WS, d), { recursive: true });
  // demo-app: main ahead of its origin by one commit, a modified + two untracked files, a feature branch on the origin
  fs.mkdirSync(FIX, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", path.join(FIX, "origin.git")]);
  const app = path.join(WS, "demo-app");
  execFileSync("git", ["clone", "-q", path.join(FIX, "origin.git"), app], { stdio: "pipe" });
  w(path.join(app, "README.md"), "# Demo app\n");
  w(path.join(app, "src/app.py"), "print(1)\n");
  sh(app, "add", "-A");
  sh(app, "commit", "-qm", "Initial commit");
  sh(app, "push", "-q", "origin", "main");
  sh(app, "checkout", "-qb", "feature/topbar");
  w(path.join(app, "src/feature.py"), "x\n");
  sh(app, "add", "-A");
  sh(app, "commit", "-qm", "Add the topbar feature");
  sh(app, "push", "-q", "origin", "feature/topbar");
  sh(app, "checkout", "-q", "main");
  sh(app, "branch", "-qD", "feature/topbar"); // only on the origin now: switching to it creates the tracking branch
  fs.appendFileSync(path.join(app, "src/app.py"), "print(2)\n");
  sh(app, "commit", "-qam", "Tune the app entry point");
  fs.appendFileSync(path.join(app, "README.md"), "more\n");
  w(path.join(app, "src/new_file.py"), "new\n");
  w(path.join(app, "notes.txt"), "y\n");
  // shared-lib: a repo too (detected when connected as a folder)
  w(path.join(WS, "shared-lib/src/lib.py"), "lib\n");
  sh(path.join(WS, "shared-lib"), "init", "-q", "-b", "develop");
  sh(path.join(WS, "shared-lib"), "add", "-A");
  sh(path.join(WS, "shared-lib"), "commit", "-qm", "lib");
  // plain-folder/tools: a repo one level down
  w(path.join(WS, "plain-folder/tools/run.sh"), "echo\n");
  sh(path.join(WS, "plain-folder/tools"), "init", "-q", "-b", "main");
  sh(path.join(WS, "plain-folder/tools"), "add", "-A");
  sh(path.join(WS, "plain-folder/tools"), "commit", "-qm", "tools");
  // "my computer": a folder to upload (node_modules / .git are skipped)
  const pc = path.join(FIX, "localpc", "my-notes");
  w(path.join(pc, "todo.md"), "# notes\n");
  w(path.join(pc, "sub/data.csv"), "a,b\n");
  w(path.join(pc, "sub/blob.bin"), Buffer.alloc(3 << 20, 7)); // two of these: more than one batch (4 MB)
  w(path.join(pc, "sub/blob2.bin"), Buffer.alloc(3 << 20, 8));
  w(path.join(pc, "node_modules/pkg/index.js"), "junk");
  w(path.join(pc, ".git/HEAD"), "ref");
}

async function api(ctx, method, url, body) {
  const r = await ctx.request.fetch(SERVER + url, { method, data: body, headers: { "Content-Type": "application/json" } });
  const t = await r.text();
  if (!r.ok()) throw new Error(`${method} ${url}: ${r.status()} ${t}`);
  return t ? JSON.parse(t) : null;
}

async function newContext(browser, phone) {
  const ctx = await browser.newContext(
    phone
      ? {
          viewport: { width: 390, height: 844 },
          deviceScaleFactor: 2,
          isMobile: true,
          hasTouch: true,
          userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        }
      : { viewport: { width: 1440, height: 900 } },
  );
  const r = await ctx.request.post(SERVER + "/api/auth/login", { data: { username: "admin", password: PASSWORD } });
  assert.ok(r.ok(), "login");
  // the checks read English labels: pin the UI language (docs/i18n.md — the machine's own locale may be Korean, and the
  // account's choice would win over the browser's)
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("hrh_lang", "en");
    } catch {}
  });
  await ctx.request.put(SERVER + "/api/preferences", { data: { language: null } }).catch(() => {});
  return ctx;
}

async function openSession(ctx, sid, { width } = {}) {
  await ctx.addInitScript((id) => {
    localStorage.setItem("hrh_last_session", id);
    localStorage.setItem("hrh_session_panel", "0");
  }, sid);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  if (width) await page.setViewportSize({ width, height: 900 });
  await page.goto(SERVER + "/");
  await page.waitForSelector('[data-testid="topbar-folders"]', { timeout: 20000 });
  await sleep(700);
  return page;
}

async function shot(page, name, top = false) {
  if (!SHOTS) return;
  const file = path.join(SHOTS, name);
  const v = page.viewportSize();
  await page.screenshot({ path: file, ...(top ? { clip: { x: 0, y: 0, width: v.width, height: Math.min(v.height, 520) } } : {}) });
  console.log(`  shot: ${file}`);
}

/** Nothing in the top bar off screen, nothing overlapping, no sideways page scroll. */
async function barFits(page, label) {
  const r = await page.evaluate(() => {
    const bar = document.querySelector('[data-testid="topbar"]');
    const items = [...bar.querySelectorAll("[data-topbar-item]")].filter((el) => el.getBoundingClientRect().width > 0);
    const rects = items.map((el) => ({ name: el.getAttribute("data-topbar-item"), ...el.getBoundingClientRect().toJSON() }));
    const off = rects.filter((b) => b.right > window.innerWidth + 0.5 || b.left < -0.5).map((b) => b.name);
    const overlap = [];
    for (let i = 1; i < rects.length; i++) if (rects[i].left < rects[i - 1].right - 0.5) overlap.push(`${rects[i - 1].name}/${rects[i].name}`);
    const ws = bar.querySelector('[data-topbar-item="workspace"]');
    return {
      off,
      overlap,
      docW: document.documentElement.scrollWidth,
      vw: window.innerWidth,
      shown: rects.map((b) => b.name),
      wsTruncated: ws && ws.getBoundingClientRect().width > 0 ? ws.lastElementChild.scrollWidth > ws.lastElementChild.clientWidth : null,
      titleW: Math.round(bar.querySelector('[data-topbar-item="title"]').getBoundingClientRect().width),
    };
  });
  console.log(`  ${label}: ${JSON.stringify({ shown: r.shown, titleW: r.titleW, wsTruncated: r.wsTruncated })}`);
  assert.ok(r.titleW >= 40, `${label}: the title keeps some room (${r.titleW}px)`);
  assert.deepEqual(r.off, [], `${label}: off screen`);
  assert.deepEqual(r.overlap, [], `${label}: overlapping`);
  assert.ok(r.docW <= r.vw + 1, `${label}: page scrolls sideways (${r.docW} > ${r.vw})`);
  return r;
}

const count = (page, sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);

// ── Folder ──
async function folderFlow(browser, phone) {
  const tag = phone ? "phone" : "desktop";
  const ctx = await newContext(browser, phone);
  const s = await api(ctx, "POST", "/api/sessions", { provider: "claude", model: "", connection_id: null, workspace_path: path.join(WS, "demo-app"), title: `Folders (${tag})` });
  const page = await openSession(ctx, s.id);

  step(`${tag}: Folder button, empty state`);
  await barFits(page, `${tag} empty`);
  await shot(page, `folder-1-empty-${tag}.png`, true);

  step(`${tag}: popover — suggestions next to the workspace`);
  await page.click('[data-testid="topbar-folders"]');
  await page.waitForSelector('[data-testid="folders-popover"]');
  await page.waitForSelector('[data-testid="folders-suggestions"] button');
  await sleep(300);
  await shot(page, `folder-2-popover-empty-${tag}.png`);

  step(`${tag}: filter, connect two folders`);
  await page.fill('[data-testid="folders-popover"] input', "shared");
  assert.equal(await count(page, '[data-testid="folders-suggestions"] button'), 1, "the filter narrows the list");
  await page.click('[data-testid="folders-suggestions"] button');
  await page.waitForSelector('[data-testid="folders-connected"] li');
  await page.fill('[data-testid="folders-popover"] input', "");
  await page.click(`[data-testid="folders-suggestions"] button[title="Connect ${path.join(WS, "docs")}"]`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="folders-connected"] li').length === 2);
  assert.deepEqual((await api(ctx, "GET", `/api/sessions/${s.id}`)).extra_dirs, [path.join(WS, "shared-lib"), path.join(WS, "docs")]);
  await shot(page, `folder-3-popover-with-folders-${tag}.png`);

  step(`${tag}: Esc closes${phone ? "" : " (focus back on the button)"}`);
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="folders-popover"]', { state: "detached" });
  if (!phone) assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), "topbar-folders");
  await barFits(page, `${tag} with folders`);
  await shot(page, `folder-4-button-with-folders-${tag}.png`, true);

  step(`${tag}: a click elsewhere closes`);
  await page.click('[data-testid="topbar-folders"]');
  await page.waitForSelector('[data-testid="folders-popover"]');
  await page.mouse.click(phone ? 200 : 700, phone ? 660 : 600);
  await page.waitForSelector('[data-testid="folders-popover"]', { state: "detached" });

  if (!phone) {
    step(`${tag}: keyboard — Enter opens, Tab reaches the rows`);
    await page.focus('[data-testid="topbar-folders"]');
    await page.keyboard.press("Enter");
    await page.waitForSelector('[data-testid="folders-popover"]');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Filter folders or type a path");
    await page.keyboard.press("Escape");
  }

  step(`${tag}: a folder from this computer → ${phone ? "not on phones (no folder picker)" : "uploaded as a copy (webkitdirectory)"}`);
  await page.click('[data-testid="topbar-folders"]');
  await page.click('[data-testid="folders-tab-local"]');
  await page.waitForSelector('[data-testid="local-folder"], [data-testid="local-folder-unavailable"]');
  await sleep(200);
  await shot(page, `folder-5-local-tab-${tag}.png`);
  if (phone) {
    assert.equal(await count(page, '[data-testid="local-folder-unavailable"]'), 1, "phones say why");
    await page.click('[data-testid="folders-tab-host"]');
  } else {
    await page.setInputFiles('[data-testid="local-folder-input"]', path.join(FIX, "localpc", "my-notes"));
    await page.waitForSelector('[data-testid="local-folder-summary"]');
    await sleep(200);
    await shot(page, `folder-6-local-summary-${tag}.png`);
    await page.route("**/folder-uploads/*/files", async (route) => {
      await sleep(1500); // slow enough to see the progress
      await route.continue();
    });
    await page.click('[data-testid="local-folder-upload"]');
    await page.waitForFunction(() => /^[1-9]/.test(document.querySelector('[data-testid="local-folder-progress"]')?.textContent || ""), null, { timeout: 15000 });
    await shot(page, `folder-7-local-uploading-${tag}.png`);
    step(`${tag}: closing the popover doesn't stop the upload; the button shows it`);
    await page.keyboard.press("Escape");
    await shot(page, `folder-7b-uploading-button-${tag}.png`, true);
    await page.waitForFunction(() => document.querySelector('[data-testid="topbar-folders"]')?.textContent?.includes("3"), null, { timeout: 30000 });
    await page.unroute("**/folder-uploads/*/files");
    await page.click('[data-testid="topbar-folders"]');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="folders-connected"] li').length === 3);
    await sleep(300);
    await shot(page, `folder-8-local-copied-${tag}.png`);
    const copy = (await api(ctx, "GET", `/api/sessions/${s.id}`)).extra_dirs[2];
    assert.equal(copy, path.join(WS, "demo-app", ".geny-uploads", "my-notes"));
    assert.equal(fs.readFileSync(path.join(copy, "sub", "blob2.bin")).length, 3 << 20);
    assert.ok(!fs.existsSync(path.join(copy, "node_modules")) && !fs.existsSync(path.join(copy, ".git")), "skipped folders stay out");
    assert.ok(fs.existsSync(path.join(copy, "todo.md")));
  }

  step(`${tag}: disconnect; show in Explorer`);
  const before = await count(page, '[data-testid="folders-connected"] li');
  await page.click('[data-testid="folders-connected"] button[aria-label="Disconnect docs"]');
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid="folders-connected"] li').length === n - 1, before);
  await page.click('[data-testid="folders-connected"] button[aria-label="Show shared-lib in Explorer"]');
  await page.waitForSelector('[data-testid="folders-popover"]', { state: "detached" });
  await sleep(900);
  await shot(page, `folder-9-explorer-${tag}.png`);
  fs.rmSync(path.join(WS, "demo-app", ".geny-uploads"), { recursive: true, force: true });
  await ctx.close();
}

// ── Git ──
const gitText = (page) => page.evaluate(() => document.querySelector('[data-testid="topbar-git"]').innerText.replace(/\s+/g, " ").trim());

async function gitFlow(browser, phone) {
  const tag = phone ? "phone" : "desktop";
  fixtures(); // a fresh repo state for each run
  const app = path.join(WS, "demo-app");
  const ctx = await newContext(browser, phone);
  const a = await api(ctx, "POST", "/api/sessions", { provider: "claude", model: "", connection_id: null, workspace_path: app, title: `Git (${tag})` });
  const page = await openSession(ctx, a.id);

  step(`${tag}: the workspace is a repo → connected: branch, changes, ahead on the button`);
  await page.waitForSelector('[data-testid="topbar-git"][data-connected="true"]');
  if (!phone) {
    const t = await gitText(page);
    assert.match(t, /main/);
    assert.match(t, /• 3/);
    assert.match(t, /↑1/);
  } else {
    assert.equal(await count(page, '[data-testid="topbar-git"] span.bg-warning'), 1, "a dot for changes on phones");
  }
  await barFits(page, `${tag} git connected`);
  await shot(page, `git-1-connected-button-${tag}.png`, true);

  step(`${tag}: popover — repo, remote, branch, changes, ahead/behind, last commit`);
  await page.click('[data-testid="topbar-git"]');
  await page.waitForSelector('[data-testid="git-popover"] [data-testid="git-files"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="git-branch-select"] option').length >= 2); // branches loaded
  const pop = await page.evaluate(() => document.querySelector('[data-testid="git-popover"]').innerText);
  for (const want of ["demo-app", "origin.git", "README.md", "notes.txt", "Tune the app entry point", "origin/main"]) assert.ok(pop.includes(want), `popover shows ${want}`);
  await sleep(200);
  await shot(page, `git-2-connected-popover-${tag}.png`);

  step(`${tag}: switch to a branch that's only on the origin`);
  await page.selectOption('[data-testid="git-branch-select"]', "remote:origin/feature/topbar");
  await page.waitForFunction(() => document.querySelector('[data-testid="git-branch-select"]').value === "feature/topbar", null, { timeout: 15000 });
  assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: app }).toString().trim(), "feature/topbar");
  if (!phone) assert.match(await gitText(page), /feature\/topbar/);
  await sleep(200);
  await shot(page, `git-3-switched-${tag}.png`);
  await page.selectOption('[data-testid="git-branch-select"]', "main");
  await page.waitForFunction(() => document.querySelector('[data-testid="git-branch-select"]').value === "main", null, { timeout: 15000 });

  step(`${tag}: a refused switch shows git's reason`);
  fs.writeFileSync(path.join(app, "src", "app.py"), "local edit\n"); // differs on feature/topbar
  await page.click('[data-testid="git-refresh"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="git-branch-select"]').options.length >= 2);
  await page.selectOption('[data-testid="git-branch-select"]', "feature/topbar");
  await page.waitForSelector('[data-testid="git-error"]', { timeout: 15000 });
  assert.match(await page.textContent('[data-testid="git-error"]'), /would be overwritten/);
  await shot(page, `git-4-switch-refused-${tag}.png`);
  execFileSync("git", ["checkout", "--", "src/app.py"], { cwd: app });
  await page.click('[data-testid="git-refresh"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="topbar-git"]').title.includes("3 changed"));
  await page.keyboard.press("Escape");

  step(`${tag}: a turn ends → the status is read again (no polling)`);
  let reads = 0;
  page.on("request", (r) => /\/api\/sessions\/[^/]+\/git$/.test(new URL(r.url()).pathname) && r.method() === "GET" && reads++);
  await sleep(1500);
  assert.equal(reads, 0, "nothing reads the status while idle");
  fs.writeFileSync(path.join(app, "agent_wrote_this.txt"), "x\n"); // as if the agent did
  await sleep(1000);
  assert.ok((await page.getAttribute('[data-testid="topbar-git"]', "title")).includes("3 changed"), "not picked up without a turn end");
  await page.fill("textarea", "q1 hello");
  await page.click('button[title="Send"], button[title="Send (Enter)"]');
  await page.waitForFunction(() => document.body.innerText.includes("Reply 1 sentence number 5"), null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="topbar-git"]').title.includes("4 changed"), null, { timeout: 15000 });
  assert.ok(reads >= 1 && reads <= 2, `status read once at the turn's end (${reads})`);
  await sleep(300);
  await shot(page, `git-5-after-turn-${tag}.png`, true);

  step(`${tag}: disconnect → not connected (muted "Git")`);
  await page.click('[data-testid="topbar-git"]');
  await page.click('[data-testid="git-disconnect"]');
  await page.waitForSelector('[data-testid="topbar-git"][data-connected="false"]');
  await page.waitForSelector('[data-testid="git-found"] li');
  await sleep(300);
  await shot(page, `git-6-disconnected-popover-${tag}.png`);
  assert.equal((await api(ctx, "GET", `/api/sessions/${a.id}`)).git_repo, "");
  await page.keyboard.press("Escape");
  await shot(page, `git-7-not-connected-button-${tag}.png`, true);

  step(`${tag}: a workspace that isn't a repo: detect repos in the chat's folders, connect one`);
  const b = await api(ctx, "POST", "/api/sessions", {
    provider: "claude", model: "", connection_id: null, workspace_path: path.join(WS, "plain-folder"), title: `Git, not a repo (${tag})`,
    extra_dirs: [path.join(WS, "shared-lib")],
  });
  const page2 = await openSession(ctx, b.id);
  await page2.waitForSelector('[data-testid="topbar-git"][data-connected="false"]');
  await page2.click('[data-testid="topbar-git"]');
  await page2.waitForFunction(() => document.querySelectorAll('[data-testid="git-found"] li').length === 2);
  await sleep(300);
  await shot(page2, `git-8-not-connected-popover-${tag}.png`);
  await page2.click('[data-testid="git-found"] button[aria-label="Connect shared-lib"]');
  await page2.waitForSelector('[data-testid="topbar-git"][data-connected="true"]');
  await page2.waitForSelector('[data-testid="git-branch-select"]');
  assert.equal(await page2.inputValue('[data-testid="git-branch-select"]'), "develop");
  await sleep(300);
  await shot(page2, `git-9-connected-found-${tag}.png`);
  await ctx.close();
}

// ── Layout: the bar at many widths, with a long title / branch, side panels open or not ──
async function layoutFlow(browser) {
  fixtures();
  const app = path.join(WS, "demo-app");
  execFileSync("git", ["checkout", "-qb", "feature/a-really-long-branch-name-for-the-top-bar"], { cwd: app });
  const ctx = await newContext(browser, false);
  const s = await api(ctx, "POST", "/api/sessions", {
    provider: "claude", model: "", connection_id: null, workspace_path: app,
    title: "A long chat title that keeps on going so the top bar has to make room for everything",
    extra_dirs: [path.join(WS, "shared-lib"), path.join(WS, "docs")],
  });
  const page = await openSession(ctx, s.id);
  await page.waitForSelector('[data-testid="topbar-git"][data-connected="true"]');
  const density = () => page.getAttribute('[data-testid="topbar"]', "data-density");
  for (const w of [1920, 1440, 1280, 1100, 1024, 900, 820, 768, 700, 640, 600, 480, 390, 360, 320]) {
    await page.setViewportSize({ width: w, height: 800 });
    await sleep(350);
    step(`width ${w}: ${await density()}`);
    const r = await barFits(page, `w${w}`);
    assert.ok(r.shown.includes("folders") && r.shown.includes("git") && r.shown.includes("explorer"), `${w}: folder, git, explorer always there`);
    if ([1920, 1440, 1024, 768, 390, 360].includes(w)) await shot(page, `layout-${w}.png`, true);
  }
  step("1440 with the explorer open, then the panel");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.click('[data-topbar-item="explorer"]');
  await sleep(500);
  await barFits(page, "1440 + explorer");
  await shot(page, "layout-1440-explorer.png", true);
  await page.click('[data-topbar-item="panel"]');
  await sleep(500);
  await barFits(page, "1440 + panel");
  const panelText = await page.evaluate(() => [...document.querySelectorAll("aside")].map((a) => a.innerText).join("\n"));
  assert.ok(!panelText.includes("Additional folders"), "the panel no longer has the folders section");
  assert.ok(panelText.includes("Changed files") && panelText.includes("Agent"), "the panel keeps its other sections");
  await shot(page, "layout-1440-panel.png", true);
  step("tasks / usage / panel still open from the bar");
  await page.click('[data-topbar-item="panel"]');
  await page.click('[data-topbar-item="usage"]');
  await sleep(500);
  await page.keyboard.press("Escape");
  await page.click('[data-topbar-item="tasks"]');
  await sleep(500);
  await page.keyboard.press("Escape");
  await ctx.close();
}

(async () => {
  fixtures();
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
  try {
    if (!ONLY || ONLY === "folder") {
      await folderFlow(browser, false);
      await folderFlow(browser, true);
    }
    if (!ONLY || ONLY === "git") {
      await gitFlow(browser, false);
      await gitFlow(browser, true);
    }
    if (!ONLY || ONLY === "layout") await layoutFlow(browser);
    console.log("OK");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
