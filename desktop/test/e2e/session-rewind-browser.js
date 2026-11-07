// Going back in a chat and copying one (docs/session-timeline.md) in a browser against a throwaway server, no real engine:
//
//   python3 desktop/test/e2e/session-rewind-server.py 18975 <frontend dist> <workspace> &
//   NODE_PATH=<dir with playwright-core> CHROME=<chromium binary> \
//     node desktop/test/e2e/session-rewind-browser.js http://127.0.0.1:18975 rewind-test-only <workspace> <shots dir>
//
// Checks: a message just sent can be rewound without a reload; the dialog says what goes; the message and all after it leave
// this window and another one, its text returns to the composer and can be sent again; a running turn is stopped by it, and
// what it changed so far is offered and goes back, and what another device queued returns to its composer; a turn's file change
// is put back when asked (and stays when not); the copy has a new name, the same settings and history, and the open chat stays
// open. ko dark, en light, desktop, phone.
"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const [SERVER, PASSWORD, WORK, SHOTS] = process.argv.slice(2);
if (!SERVER || !PASSWORD || !WORK || !SHOTS) {
  console.error("usage: node session-rewind-browser.js <server url> <password> <workspace> <shots dir>");
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

async function context(browser, { lang = "ko", theme = "dark", sid, phone = false }) {
  const ctx = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1360, height: 900 }, colorScheme: theme, isMobile: phone, hasTouch: phone, deviceScaleFactor: phone ? 2 : 1 });
  await ctx.addInitScript(
    ([l, th, id]) => {
      localStorage.setItem("hrh_lang", l);
      localStorage.setItem("hrh_theme", th);
      localStorage.setItem("hrh_setup_seen_v2", "1");
      if (id) localStorage.setItem("hrh_last_session", id);
    },
    [lang, theme, sid],
  );
  const r = await ctx.request.post(`${SERVER}/api/auth/login`, { data: { username: "admin", password: PASSWORD } });
  assert.ok(r.ok(), "login");
  return ctx;
}
const api = async (ctx, method, url, data) => {
  const r = await ctx.request.fetch(SERVER + url, { method, data, headers: { "Content-Type": "application/json" } });
  assert.ok(r.ok(), `${method} ${url}: ${r.status()}`);
  return r.json();
};

const composer = (p) => p.locator("textarea").first();
async function openChat(p, sid) {
  await p.goto(`${SERVER}/?view=chat&session=${sid}`);
  await composer(p).waitFor({ timeout: 30000 });
}
async function send(p, text) {
  await composer(p).fill(text);
  await composer(p).press("Enter");
}
const bubbles = (p) => p.locator('[data-testid="rewind-open"]');
const waitIdle = (ctx, sid) => until("the turn to end", async () => !(await api(ctx, "GET", `/api/sessions/${sid}`)).running);
const texts = async (ctx, sid) => (await api(ctx, "GET", `/api/sessions/${sid}/messages`)).map((m) => `${m.role}: ${m.content.slice(0, 40)}`);

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true, args: ["--no-sandbox"] });
  const errors = [];
  const watch = (p) => p.on("pageerror", (e) => errors.push(e.message));
  try {
    const boot = await context(browser, {});
    const s = await api(boot, "POST", "/api/sessions", { provider: "claude", model: "sonnet", effort: "high", workspace_path: WORK, title: "작업" });
    const sid = s.id;

    step("a message just sent can be rewound, without a reload");
    const ctx = await context(browser, { sid });
    const p = await ctx.newPage();
    watch(p);
    await openChat(p, sid);
    const other = await ctx.newPage();
    watch(other);
    await openChat(other, sid);
    await p.bringToFront();
    await send(p, "첫 번째 메시지");
    await waitIdle(boot, sid);
    await send(p, "두 번째 메시지");
    await waitIdle(boot, sid);
    await until("two buttons", async () => (await bubbles(p).count()) === 2);
    assert.equal((await texts(boot, sid)).length, 4);

    step("the dialog says what goes, and Cancel changes nothing");
    await bubbles(p).nth(1).locator("xpath=..").hover();
    await bubbles(p).nth(1).click();
    await p.waitForSelector('[data-testid="rewind-confirm"]:not([disabled])');
    assert.match(await p.locator('[data-testid="rewind-gone"]').textContent(), /1개/);
    await p.screenshot({ path: path.join(SHOTS, "dialog-ko-dark.png") });
    await p.getByRole("button", { name: "취소" }).click();
    assert.equal((await texts(boot, sid)).length, 4);

    step("rewinding: gone here and in another window, the text back in the composer");
    await composer(p).fill("쓰고 있던 글");
    await bubbles(p).nth(1).click();
    await p.click('[data-testid="rewind-confirm"]:not([disabled])');
    await p.waitForSelector('[data-testid="rewind-dialog"]', { state: "detached", timeout: 15000 });
    assert.deepEqual((await texts(boot, sid)).filter((x) => x.startsWith("user")), ["user: 첫 번째 메시지"]);
    await until("the bubble to leave", async () => (await bubbles(p).count()) === 1);
    assert.equal(await composer(p).inputValue(), "두 번째 메시지\n\n쓰고 있던 글");
    await until("the other window to follow", async () => (await bubbles(other).count()) === 1);
    assert.equal(await p.getByText("두 번째 메시지", { exact: true }).count(), 0, "not on screen");
    await p.screenshot({ path: path.join(SHOTS, "rewound-ko-dark.png") });

    step("it can be sent again");
    await composer(p).fill("다시 보낸 메시지");
    await composer(p).press("Enter");
    await waitIdle(boot, sid);
    await until("sent", async () => (await texts(boot, sid)).includes("user: 다시 보낸 메시지"));

    step("a running turn is stopped by it, and its file change goes back when asked");
    const edited = path.join(WORK, "tracked.txt");
    const added = path.join(WORK, "added.txt");
    const starts = async () => (await api(boot, "GET", `/api/sessions/${sid}/events`)).filter((e) => e.type === "session.start").length;
    const started = await starts();
    await send(p, "파일을 바꾸는 턴");
    await until("the engine to start (after the snapshot of the folder)", async () => (await starts()) > started);
    fs.writeFileSync(edited, "after\n");
    fs.writeFileSync(added, "new\n");
    await waitIdle(boot, sid);
    await until("the change on record", async () => (await api(boot, "GET", `/api/sessions/${sid}/events`)).some((e) => e.type === "turn.changes"));
    const during = path.join(WORK, "during.txt");
    const away = await (await context(browser, { sid })).newPage();
    watch(away);
    await openChat(away, sid);
    const startedAgain = await starts();
    await send(p, "멈출 턴");
    await until("it runs", async () => (await api(boot, "GET", `/api/sessions/${sid}`)).running);
    await until("the engine to start again", async () => (await starts()) > startedAgain);
    await until("its button", async () => (await bubbles(p).count()) === 4);
    fs.writeFileSync(during, "written while it worked\n");
    await composer(away).fill("다른 기기의 대기 메시지");
    await away.getByRole("button", { name: "대기열" }).click();
    await until("it to be queued there", async () => (await composer(away).inputValue()) === "");
    await bubbles(p).nth(3).click();
    await p.waitForSelector('[data-testid="rewind-confirm"]:not([disabled])');
    assert.equal(await p.locator('[data-testid="rewind-files"]').isChecked(), true, "what the turn at work changed is offered");
    await p.screenshot({ path: path.join(SHOTS, "dialog-running-ko-dark.png") });
    await p.click('[data-testid="rewind-confirm"]');
    await p.waitForSelector('[data-testid="rewind-dialog"]', { state: "detached", timeout: 30000 });
    assert.equal((await api(boot, "GET", `/api/sessions/${sid}`)).running, false);
    assert.equal(fs.existsSync(during), false, "what it changed went back");
    assert.equal(fs.readFileSync(edited, "utf8"), "after\n", "what the turn before it changed stays");
    await until("what the other device queued to be back in its composer", async () => (await composer(away).inputValue()) === "다른 기기의 대기 메시지");
    assert.ok(!(await texts(boot, sid)).includes("user: 다른 기기의 대기 메시지"), "it didn't go out when the turn stopped");
    await away.close();

    await until("three buttons", async () => (await bubbles(p).count()) === 3);
    await bubbles(p).nth(2).click();
    await p.waitForSelector('[data-testid="rewind-files"]');
    assert.equal(await p.locator('[data-testid="rewind-files"]').isChecked(), true);
    await p.screenshot({ path: path.join(SHOTS, "dialog-files-ko-dark.png") });
    await p.click('[data-testid="rewind-confirm"]');
    await p.waitForSelector('[data-testid="rewind-dialog"]', { state: "detached", timeout: 30000 });
    assert.equal(fs.readFileSync(edited, "utf8"), "before\n");
    assert.equal(fs.existsSync(added), false);
    await composer(p).fill("");

    step("copy: from the menu, at once, a new name, the same settings and history, and this chat stays open");
    await until("the chat in the list", async () => (await p.getByText("작업", { exact: true }).count()) > 0);
    await p.getByText("작업", { exact: true }).first().hover();
    await p.getByRole("button", { name: "채팅 메뉴" }).first().click();
    await p.click('[data-testid="session-copy"]');
    await until("the copy in the list", async () => (await p.getByText("작업_copy_1", { exact: true }).count()) > 0);
    assert.ok(new URL(p.url()).search.includes(sid) || (await composer(p).count()) > 0, "this chat stays open");
    const all = await api(boot, "GET", "/api/sessions");
    const copy = all.find((x) => x.title === "작업_copy_1");
    assert.ok(copy && copy.id !== sid);
    for (const k of ["provider", "model", "effort", "mode", "workspace_path", "connection_id"]) assert.equal(copy[k], s[k], k);
    assert.deepEqual(await texts(boot, copy.id), await texts(boot, sid));
    await p.screenshot({ path: path.join(SHOTS, "copied-ko-dark.png") });
    await p.getByText("작업_copy_1", { exact: true }).first().click();
    await until("the copy opens", async () => (await bubbles(p).count()) === 2);
    await send(p, "복사본에서 보낸 메시지");
    await waitIdle(boot, copy.id);
    await until("sent there", async () => (await texts(boot, copy.id)).includes("user: 복사본에서 보낸 메시지"));
    assert.ok(!(await texts(boot, sid)).includes("user: 복사본에서 보낸 메시지"), "the original goes on alone");

    step("phone, English, light: the button is there without hovering");
    const ph = await context(browser, { lang: "en", theme: "light", sid, phone: true });
    const q = await ph.newPage();
    watch(q);
    await openChat(q, sid);
    await until("buttons", async () => (await bubbles(q).count()) === 2);
    assert.notEqual(await bubbles(q).first().evaluate((el) => getComputedStyle(el).opacity), "0");
    await bubbles(q).first().click();
    await q.waitForSelector('[data-testid="rewind-confirm"]:not([disabled])');
    await q.screenshot({ path: path.join(SHOTS, "dialog-en-light-phone.png") });
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
