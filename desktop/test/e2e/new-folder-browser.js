// New folder in the folder pickers (frontend components/workspaces/FileTree.tsx), in a browser against a throwaway
// server (no real engine):
//
//   python3 desktop/test/e2e/session-rewind-server.py 18981 <frontend dist> <workspace> &
//   NODE_PATH=<dir with playwright-core> CHROME=<chromium binary> \
//     node desktop/test/e2e/new-folder-browser.js http://127.0.0.1:18981 rewind-test-only <workspace> <shots dir>
//
// Checks: New chat → the tree's "New folder" makes a folder where it stands and opens it; "use this" and Start chat
// put the chat there; a taken name, a path and an empty name are refused with why; Esc cancels; the chat's
// Add-folder browser has it too. English light desktop, Korean dark phone.
"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const [SERVER, PASSWORD, WORK, SHOTS] = process.argv.slice(2);
if (!SERVER || !PASSWORD || !WORK || !SHOTS) {
  console.error("usage: node new-folder-browser.js <server url> <password> <workspace> <shots dir>");
  process.exit(2);
}
fs.mkdirSync(SHOTS, { recursive: true });
const step = (s) => console.log(`• ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 30000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}
async function context(browser, { lang = "en", theme = "light", phone = false } = {}) {
  const ctx = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1360, height: 900 },
    colorScheme: theme, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  await ctx.addInitScript(([l, th]) => {
    localStorage.setItem("hrh_lang", l);
    localStorage.setItem("hrh_theme", th);
    localStorage.setItem("hrh_setup_seen_v2", "1");
    localStorage.setItem("hrh_session_panel", "0");
  }, [lang, theme]);
  assert.ok((await ctx.request.post(`${SERVER}/api/auth/login`, { data: { username: "admin", password: PASSWORD } })).ok());
  return ctx;
}
/** the tree at ``dir`` (typed into its path bar) */
async function treeAt(p, dir) {
  await p.waitForLoadState("networkidle").catch(() => {});
  await p.locator('[data-testid="new-folder"]').first().waitFor(); // (the tree has listed where it starts)
  await p.getByRole("button", { name: /Edit path|경로 편집/ }).first().click();
  const input = p.locator("input:focus"); // (the path bar's field, focused when it opens)
  await input.fill(dir);
  await input.press("Enter");
  await until("the tree there", async () => (await p.locator('[data-testid="new-folder"]').count()) > 0);
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true, args: ["--no-sandbox"] });
  const errors = [];
  try {
    const ctx = await context(browser);
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(e.message));

    step("New chat: the tree makes a folder where it stands and opens it");
    await p.goto(`${SERVER}/`);
    await treeAt(p, WORK);
    await p.click('[data-testid="new-folder"]');
    await p.fill('[data-testid="new-folder-name"]', "my-project");
    assert.match(await p.locator('[data-testid="new-folder-note"]').textContent(), new RegExp(`In ${WORK.replace(/[/.]/g, "\\$&")}`));
    await p.screenshot({ path: path.join(SHOTS, "naming-en-light.png") });
    await p.press('[data-testid="new-folder-name"]', "Enter");
    const made = path.join(WORK, "my-project");
    await until("the folder on disk", () => fs.existsSync(made) && fs.statSync(made).isDirectory());
    await until("the tree inside it", async () => (await p.getByRole("button", { name: "my-project", exact: true }).count()) > 0);
    assert.equal(await p.locator('[data-testid="new-folder-form"]').count(), 0);

    step("use this → Start chat: the chat works there");
    await p.getByRole("button", { name: /^use this$/ }).click();
    await p.getByRole("button", { name: "Start chat" }).click();
    await until("the chat", async () => new URL(p.url()).searchParams.get("session"));
    const sid = new URL(p.url()).searchParams.get("session");
    const s = await (await ctx.request.get(`${SERVER}/api/sessions/${sid}`)).json();
    assert.equal(s.workspace_path, made);

    step("a taken name, a path, an empty name: refused with why; Esc cancels");
    await p.getByRole("button", { name: "New chat" }).first().click(); // (the address alone reopens the last chat)
    await treeAt(p, WORK);
    await p.click('[data-testid="new-folder"]');
    await p.fill('[data-testid="new-folder-name"]', "my-project");
    await p.click('[data-testid="new-folder-create"]');
    await until("taken", async () => /already exists here/.test(await p.locator('[data-testid="new-folder-note"]').textContent()));
    await p.fill('[data-testid="new-folder-name"]', "a/b");
    await p.click('[data-testid="new-folder-create"]');
    assert.match(await p.locator('[data-testid="new-folder-note"]').textContent(), /can't contain/);
    assert.equal(fs.existsSync(path.join(WORK, "a")), false);
    await p.fill('[data-testid="new-folder-name"]', "");
    assert.equal(await p.locator('[data-testid="new-folder-create"]').isDisabled(), true);
    await p.press('[data-testid="new-folder-name"]', "Escape");
    assert.equal(await p.locator('[data-testid="new-folder-form"]').count(), 0);
    // a filter that found nothing is the name offered
    await p.fill('input[placeholder="filter"]', "notes-2026");
    await p.click('[data-testid="new-folder"]');
    assert.equal(await p.inputValue('[data-testid="new-folder-name"]'), "notes-2026");
    await p.press('[data-testid="new-folder-name"]', "Enter");
    await until("made from the filter", () => fs.existsSync(path.join(WORK, "notes-2026")));

    step("the chat's Add-folder browser has it too");
    await p.goto(`${SERVER}/?view=chat&session=${sid}`);
    await p.locator('[data-testid="topbar-folders"]').click();
    await p.locator('[data-testid="folders-browse"]').click();
    await p.locator('[data-testid="new-folder"]').first().waitFor();
    await p.click('[data-testid="new-folder"]');
    await p.fill('[data-testid="new-folder-name"]', "extra");
    await p.press('[data-testid="new-folder-name"]', "Enter");
    await until("made next to the workspace", async () => (await p.getByRole("button", { name: "extra", exact: true }).count()) > 0);
    await p.screenshot({ path: path.join(SHOTS, "add-folder-en-light.png") });

    step("Korean, dark, phone");
    const ko = await context(browser, { lang: "ko", theme: "dark", phone: true });
    const q = await ko.newPage();
    q.on("pageerror", (e) => errors.push(e.message));
    await q.goto(`${SERVER}/`);
    // (it reopens the last chat: New chat from the menu)
    await q.getByRole("button", { name: "메뉴 열기" }).first().click();
    await q.getByRole("button", { name: "새 채팅" }).first().click();
    await treeAt(q, WORK);
    await q.click('[data-testid="new-folder"]');
    await q.fill('[data-testid="new-folder-name"]', "새 프로젝트");
    await q.screenshot({ path: path.join(SHOTS, "naming-ko-dark-phone.png") });
    await q.press('[data-testid="new-folder-name"]', "Enter");
    await until("made", () => fs.existsSync(path.join(WORK, "새 프로젝트")));
    const overflow = await q.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `no sideways scroll (${overflow}px)`);

    assert.deepEqual(errors, [], "no page errors");
    console.log("OK");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
