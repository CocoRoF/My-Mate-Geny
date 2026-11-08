// LivLiv bodies (docs/mate.md "Avatar kinds") in a browser against a throwaway server, no credits:
//
//   python3 desktop/test/e2e/mate-outfit-server.py 18978 <frontend dist> &
//   NODE_PATH=<dir with playwright-core> CHROME=<chromium binary> \
//     node desktop/test/e2e/mate-livliv-browser.js http://127.0.0.1:18978 outfit-test-only <shots dir> <a .livliv package>
//
// Checks: a .livliv uploaded through the import comes in as her body; LivLiv Player draws it on the stage (WebGL2: SwiftShader
// here); a reply's [smile] plays the model's smile; Settings → Avatar shows what the package says about itself, its expression map
// and the import that takes .livliv; the phone stage plays it too. No page errors.
"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const [SERVER, PASSWORD, SHOTS, PACKAGE] = process.argv.slice(2);
if (!SERVER || !PASSWORD || !SHOTS || !PACKAGE) {
  console.error("usage: node mate-livliv-browser.js <server url> <password> <shots dir> <package.livliv>");
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
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

async function context(browser, { mateId, phone = false }) {
  const ctx = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1360, height: 900 }, colorScheme: "dark",
                                         isMobile: phone, hasTouch: phone, deviceScaleFactor: phone ? 2 : 1 });
  await ctx.addInitScript((id) => {
    localStorage.setItem("hrh_lang", "ko");
    localStorage.setItem("hrh_mate_muted", "1");
    localStorage.setItem("hrh_setup_seen_v2", "1");
    if (id) localStorage.setItem("hrh_mate_active", id);
  }, mateId);
  const r = await ctx.request.post(`${SERVER}/api/auth/login`, { data: { username: "admin", password: PASSWORD } });
  assert.ok(r.ok(), "login");
  return ctx;
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true,
                                          args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const errors = [];
  try {
    const boot = await context(browser, {});
    const mate = await (await boot.request.post(`${SERVER}/api/mates`, { data: { name: "세나" } })).json();
    step("a .livliv comes in through the import");
    const up = await boot.request.post(`${SERVER}/api/mates/${mate.id}/avatar/import`, {
      multipart: { file: { name: path.basename(PACKAGE), mimeType: "application/vnd.livliv.model+zip", buffer: fs.readFileSync(PACKAGE) } },
    });
    assert.ok(up.ok(), `import: ${await up.text()}`);
    const lv = (await up.json()).avatar.livliv;
    assert.ok(lv.model.includes("/assets/lv-") && lv.expressions.includes("smile"), JSON.stringify(lv));

    step("the stage draws her (LivLiv Player, WebGL2)");
    const ctx = await context(browser, { mateId: mate.id });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(`${SERVER}/?view=mate`);
    const body = p.locator('[data-mate-body="livliv"]').first();
    await until("the body ready", async () => (await body.getAttribute("data-mate-status")) === "ready", 45000);
    await sleep(1500);
    const box = await p.locator('[data-mate-kind="livliv"]').first().boundingBox();
    assert.ok(box && box.width > 150 && box.height > 200, `the stage box: ${JSON.stringify(box)}`);
    await p.screenshot({ path: path.join(SHOTS, "livliv-stage.png"), clip: box });

    step("a reply's [smile] plays her smile");
    await p.fill('[data-testid="mate-input"]', "md1");
    await p.keyboard.press("Enter");
    await until("her smile", async () => (await body.getAttribute("data-mate-face")) === "smile", 40000);
    await sleep(900);
    await p.screenshot({ path: path.join(SHOTS, "livliv-smile.png"), clip: box });

    step("Settings → Avatar: what the package says, its expression map, and an import that takes .livliv");
    await p.click('[data-testid="mate-settings-open"]');
    await p.click('[data-testid="mate-tab-avatar"]');
    await p.waitForSelector('[data-testid="mate-livliv-info"]');
    const info = await p.locator('[data-testid="mate-livliv-info"]').innerText();
    assert.ok(info.includes(lv.name), info);
    assert.ok((await p.locator('[data-testid="mate-livliv-map"] select').count()) >= 10, "an expression for each emotion");
    assert.ok((await p.locator('[data-testid="mate-avatar-import-file"]').getAttribute("accept")).includes(".livliv"));
    await p.locator('[data-testid="mate-livliv-editor"]').screenshot({ path: path.join(SHOTS, "livliv-settings.png") });

    step("the phone stage plays it too");
    const phone = await context(browser, { mateId: mate.id, phone: true });
    const q = await phone.newPage();
    q.on("pageerror", (e) => errors.push(e.message));
    await q.goto(`${SERVER}/?view=mate`);
    const pbody = q.locator('[data-mate-body="livliv"]').first();
    await until("the phone body ready", async () => (await pbody.getAttribute("data-mate-status")) === "ready", 45000);
    await sleep(1200);
    await q.screenshot({ path: path.join(SHOTS, "livliv-phone.png") });

    assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
    console.log("ok: LivLiv body imported, drawn, smiling on cue, set up in settings, on the phone too");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
