// Deleting what the user wrote (backend services/hidden_messages.py) in a browser against a throwaway server, no real engine:
//
//   python3 desktop/test/e2e/session-rewind-server.py 18981 <frontend dist> <workspace> &
//   NODE_PATH=<dir with playwright-core> CHROME=<chromium binary> \
//     node desktop/test/e2e/message-delete-browser.js http://127.0.0.1:18981 rewind-test-only <workspace> <picture> <shots dir>
//
// Checks: in a mate's conversation, a message sent with a photo — Delete (on hover), the dialog, and it is gone with its photo
// from this window and from a phone that has the same conversation open, live, and after a reload; her reply and the other
// messages stay; on the phone Delete shows once a bubble is tapped; in a chat the same, the agent's answer staying.
"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const [SERVER, PASSWORD, WORK, PICTURE, SHOTS] = process.argv.slice(2);
if (!SERVER || !PASSWORD || !WORK || !PICTURE || !SHOTS) {
  console.error("usage: node message-delete-browser.js <server url> <password> <workspace> <picture> <shots dir>");
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

async function context(browser, { lang = "ko", theme = "dark", mate = "", phone = false }) {
  const ctx = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1360, height: 900 }, colorScheme: theme, isMobile: phone, hasTouch: phone, deviceScaleFactor: phone ? 2 : 1 });
  await ctx.addInitScript(
    ([l, th, m]) => {
      localStorage.setItem("hrh_lang", l);
      localStorage.setItem("hrh_theme", th);
      localStorage.setItem("hrh_setup_seen_v2", "1");
      if (m) localStorage.setItem("hrh_mate_active", m);
    },
    [lang, theme, mate],
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
const idle = (ctx, sid) => until("the turn to end", async () => !(await api(ctx, "GET", `/api/sessions/${sid}`)).running, 60000);
const shown = (ctx, sid) => api(ctx, "GET", `/api/sessions/${sid}/messages`);

/** attach the picture through the composer's file input, then send */
async function sendWithPicture(p, input, text) {
  const uploaded = p.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/attachments") && r.ok());
  await p.setInputFiles('[data-testid="composer-file-input"]', PICTURE);
  await uploaded;
  await sleep(300);
  await p.locator(input).first().fill(text);
  await p.locator(input).first().press("Enter");
}
const mateBubble = (p, text) => p.locator('[data-testid="mate-user-message"]').filter({ hasText: text });

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true, args: ["--no-sandbox"] });
  const errors = [];
  const watch = (p) => p.on("pageerror", (e) => errors.push(e.message));
  try {
    const boot = await context(browser, {});
    const mate = await api(boot, "POST", "/api/mates", { name: `Delete ${Date.now() % 10000}` });
    const conv = await api(boot, "POST", `/api/mates/${mate.id}/conversation`);
    const msid = conv.session_id;

    step("a mate's conversation: a message with a photo, her reply, another message");
    const desk = await context(browser, { mate: mate.id });
    const a = await desk.newPage();
    watch(a);
    await a.goto(`${SERVER}/?view=mate`);
    await a.waitForSelector('[data-testid="mate-input"]', { timeout: 30000 });
    await sleep(1200);
    await sendWithPicture(a, '[data-testid="mate-input"]', "지워질 메시지와 사진");
    await idle(boot, msid);
    await a.locator('[data-testid="mate-input"]').first().fill("남을 메시지");
    await a.locator('[data-testid="mate-input"]').first().press("Enter");
    await idle(boot, msid);
    await mateBubble(a, "남을 메시지").waitFor({ timeout: 20000 });
    const gone = mateBubble(a, "지워질 메시지와 사진");
    await gone.waitFor();
    assert.equal(await gone.locator('[data-testid="mate-user-attachments"] img').count(), 1, "the photo is shown with it");
    const replies = await a.locator('[data-testid="mate-turn"]').count();
    assert.ok(replies >= 2, `her replies (${replies})`);

    step("the same conversation on a phone (en, light)");
    const phoneCtx = await context(browser, { lang: "en", theme: "light", mate: mate.id, phone: true });
    const b = await phoneCtx.newPage();
    watch(b);
    await b.goto(`${SERVER}/?view=mate`);
    await mateBubble(b, "지워질 메시지와 사진").waitFor({ timeout: 30000 });

    step("Delete on hover → the dialog says what goes and what stays");
    assert.equal(await gone.locator('[data-testid="delete-message"]').evaluate((el) => getComputedStyle(el).opacity), "0", "out of sight until hovered");
    await gone.hover();
    await until("Delete to show on hover", async () => (await gone.locator('[data-testid="delete-message"]').evaluate((el) => getComputedStyle(el).opacity)) === "1", 5000);
    await gone.locator('[data-testid="delete-message"]').click();
    const dialog = a.locator('[data-testid="delete-message-dialog"]');
    await dialog.waitFor();
    const said = await dialog.innerText();
    assert.match(said, /지워질 메시지와 사진/);
    assert.match(said, /사진·파일 1개/);
    assert.match(said, /맥락과 기억에서는 남을 수도 있어요/);
    await a.screenshot({ path: path.join(SHOTS, "01-mate-delete-dialog-ko-dark.png") });
    await dialog.locator('[data-testid="delete-message-confirm"]').click();
    await until("the dialog to close", async () => !(await dialog.count()));

    step("gone here and on the phone at once, photo and all; her replies and the other message stay");
    await until("gone here", async () => !(await mateBubble(a, "지워질 메시지와 사진").count()));
    await until("gone on the phone without a reload", async () => !(await mateBubble(b, "지워질 메시지와 사진").count()), 10000);
    for (const p of [a, b]) {
      assert.equal(await mateBubble(p, "남을 메시지").count(), 1, "the other message stays");
      assert.equal(await p.locator('[data-testid="mate-user-attachments"]').count(), 0, "no photo left");
      assert.equal(await p.locator('[data-testid="mate-turn"]').count(), replies, "her replies stay");
    }
    await a.screenshot({ path: path.join(SHOTS, "02-mate-after-delete-ko-dark.png") });

    step("after a reload too, and the server hands it out empty");
    await b.reload();
    await mateBubble(b, "남을 메시지").waitFor({ timeout: 30000 });
    await sleep(800);
    assert.equal(await mateBubble(b, "지워질 메시지와 사진").count(), 0);
    assert.equal(await b.locator('[data-testid="mate-user-attachments"]').count(), 0);
    const msgs = await shown(boot, msid);
    const hidden = msgs.filter((m) => m.meta && m.meta.hidden);
    assert.equal(hidden.length, 1);
    assert.deepEqual([hidden[0].content, hidden[0].attachments], ["", []]);
    assert.ok(!JSON.stringify(msgs).includes("지워질"), "nowhere in what a view gets");

    step("on the phone, Delete shows once a bubble is tapped (and Cancel keeps it)");
    const keep = mateBubble(b, "남을 메시지");
    const del = keep.locator('[data-testid="delete-message"]');
    assert.equal(await del.evaluate((el) => getComputedStyle(el).opacity), "0", "not under every bubble");
    await keep.locator('[data-testid="mate-user-bubble"]').tap();
    await until("Delete to show after a tap", async () => (await del.evaluate((el) => getComputedStyle(el).opacity)) === "1", 5000);
    await b.screenshot({ path: path.join(SHOTS, "03-mate-phone-tapped-en-light.png") });
    await del.tap();
    const pd = b.locator('[data-testid="delete-message-dialog"]');
    await pd.waitFor();
    assert.match(await pd.innerText(), /on every device/);
    await b.screenshot({ path: path.join(SHOTS, "04-mate-phone-dialog-en-light.png") });
    await pd.getByRole("button", { name: "Cancel" }).tap();
    await until("the dialog to close", async () => !(await pd.count()));
    assert.equal(await mateBubble(b, "남을 메시지").count(), 1, "Cancel keeps it");

    step("a chat: the same, the agent's answer staying");
    const sid = (await api(boot, "POST", "/api/sessions", { provider: "claude", model: "sonnet", workspace_path: WORK, title: "Delete" })).id;
    const c = await desk.newPage();
    watch(c);
    await c.goto(`${SERVER}/?view=chat&session=${sid}`);
    await c.locator("textarea").first().waitFor({ timeout: 30000 });
    await sendWithPicture(c, "textarea", "chat secret with a picture");
    await idle(boot, sid);
    await c.locator("textarea").first().fill("chat message that stays");
    await c.locator("textarea").first().press("Enter");
    await idle(boot, sid);
    const userMsg = (text) => c.locator(".group").filter({ hasText: text }).filter({ has: c.locator('[data-testid="delete-message"]') });
    await userMsg("chat message that stays").first().waitFor({ timeout: 20000 });
    const answers = (await shown(boot, sid)).filter((m) => m.role === "assistant").length;
    const target = userMsg("chat secret with a picture").first();
    await target.hover();
    await target.locator('[data-testid="delete-message"]').click();
    await c.locator('[data-testid="delete-message-confirm"]').click();
    await until("gone from the chat", async () => !(await c.getByText("chat secret with a picture").count()));
    assert.equal(await c.getByText("chat message that stays").count(), 1);
    await c.reload();
    await c.getByText("chat message that stays").waitFor({ timeout: 30000 });
    assert.equal(await c.getByText("chat secret with a picture").count(), 0, "after a reload too");
    const after = await shown(boot, sid);
    assert.equal(after.filter((m) => m.role === "assistant").length, answers, "the answers stay");
    assert.ok(!JSON.stringify(after).includes("chat secret"));
    await c.screenshot({ path: path.join(SHOTS, "05-chat-after-delete-ko-dark.png") });

    assert.deepEqual(errors, [], "no page errors");
    console.log("OK");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
