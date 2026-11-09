// The composer's queue (frontend/src/components/composer/useComposer.ts) in a browser, against a throwaway server
// whose engine is desktop/test/e2e/fake-claude.py (every reply takes ~3.5 s):
//
//   python3 desktop/test/e2e/session-rewind-server.py 18979 <frontend dist> <workspace> &
//   NODE_PATH=<dir with playwright-core> CHROME=<chromium binary> \
//     node desktop/test/e2e/composer-queue-browser.js http://127.0.0.1:18979 rewind-test-only <workspace> <shots dir>
//
// Checks: three messages queued while a turn runs go out one at a time, each as its own turn after the one before has
// ended, in order, none lost; a message sent now (Enter) while they wait skips the queue and joins the running turn, and
// the queue follows after; a message sent just as a turn ends isn't lost either.
"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const [SERVER, PASSWORD, WORK, SHOTS] = process.argv.slice(2);
if (!SERVER || !PASSWORD || !WORK || !SHOTS) {
  console.error("usage: node composer-queue-browser.js <server url> <password> <workspace> <shots dir>");
  process.exit(2);
}
fs.mkdirSync(SHOTS, { recursive: true });
const step = (s) => console.log(`• ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 60000) {
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

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true, args: ["--no-sandbox"] });
  const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctx.addInitScript(() => {
      localStorage.setItem("hrh_lang", "en");
      localStorage.setItem("hrh_setup_seen_v2", "1");
      localStorage.setItem("hrh_session_panel", "0");
    });
    assert.ok((await ctx.request.post(`${SERVER}/api/auth/login`, { data: { username: "admin", password: PASSWORD } })).ok());
    const api = async (url, method = "GET", data) => {
      const r = await ctx.request.fetch(SERVER + url, { method, data, headers: { "Content-Type": "application/json" } });
      assert.ok(r.ok(), `${method} ${url}: ${r.status()}`);
      return r.json();
    };
    const sid = (await api("/api/sessions", "POST", { provider: "claude", model: "sonnet", workspace_path: WORK, title: "Queue" })).id;
    const running = async () => (await api(`/api/sessions/${sid}`)).running;
    const messages = async () => (await api(`/api/sessions/${sid}/messages`)).map((m) => ({ role: m.role, text: m.content }));
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(`${SERVER}/?view=chat&session=${sid}`);
    const box = p.locator("textarea").first();
    await box.waitFor();

    step("a turn runs; three messages are queued, one is sent now");
    await box.fill("first message");
    await box.press("Enter");
    await until("the turn to run", running);
    for (const q of ["queued one", "queued two", "queued three"]) {
      await box.fill(q);
      await p.getByRole("button", { name: "Queue", exact: true }).click();
    }
    await until("three in the queue", async () => (await p.locator('[data-testid="composer-queue"] > *').count()) === 3);
    await box.fill("added now");
    await box.press("Enter");
    await p.screenshot({ path: path.join(SHOTS, "queued.png") });

    step("the queue goes one turn at a time, in order, none lost");
    const dump = async () => console.log("  messages:", JSON.stringify(await messages()), "\n  events:",
      JSON.stringify((await api(`/api/sessions/${sid}/events`)).filter((e) => ["user.message", "user.steer", "turn.complete", "error"].includes(e.type)).map((e) => [e.type, e.data.text || e.data.code || ""])));
    await until("every queued message answered", async () => {
      const ms = await messages();
      const users = ms.filter((m) => m.role === "user").map((m) => m.text);
      return users.length === 4 && !(await running()) && ms[ms.length - 1].role === "assistant";
    }, 120000).catch(async (e) => { await dump(); throw e; });
    const ms = await messages();
    const users = ms.filter((m) => m.role === "user").map((m) => m.text);
    assert.deepEqual(users, ["first message", "queued one", "queued two", "queued three"]);
    // each queued message is a turn of its own: an answer before the next one starts
    for (const q of ["queued one", "queued two"]) {
      const i = ms.findIndex((m) => m.role === "user" && m.text === q);
      const next = ms.findIndex((m, k) => k > i && m.role === "user");
      assert.ok(ms.slice(i + 1, next).some((m) => m.role === "assistant"), `${q} was answered before the next one went`);
    }
    // the one sent now skipped the queue: it joined the first turn, before any queued message
    const now = ms.findIndex((m) => m.text === "added now");
    assert.ok(now > 0 && now < ms.findIndex((m) => m.text === "queued one"), "sent now: before the queue");
    assert.equal(ms[now].role, "steer");
    assert.equal(await p.locator('[data-testid="composer-queue"] > *').count(), 0, "the queue is empty");
    const errorsShown = await p.locator("text=already running").count();
    assert.equal(errorsShown, 0);
    await p.screenshot({ path: path.join(SHOTS, "done.png") });

    step("a message sent just as a turn ends isn't lost");
    const answers = async () => (await messages()).filter((m) => m.role === "assistant").length;
    const before = await answers();
    await box.fill("second round");
    await box.press("Enter");
    await until("it runs", running);
    // the moment its answer is in on this page, send (the server may still be closing the turn)
    await until("its answer on the page", async () => (await p.getByText(/Reply \d+ sentence number 5/).count()) > before, 60000);
    await box.fill("right after");
    await box.press("Enter");
    await until("both answered", async () => {
      const all = await messages();
      return all.some((m) => m.role === "user" && m.text === "right after") && !(await running())
        && all[all.length - 1].role === "assistant";
    }, 60000);

    assert.deepEqual(errors, [], "no page errors");
    console.log("OK");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
