// A mate's memory network and studies (docs/mate-memory-graph.md) in a browser, against a throwaway server whose mate
// has a seeded network (a page with facts, the user's memories linked to what they name, a long-faded thing, a finished
// and a running study):
//
//   NODE_PATH=<playwright-core> CHROME=<chromium> \
//     node desktop/test/e2e/memory-network-browser.js <server url> <password> <shots dir> <seed command>
//
// <seed command> is run with the new mate's id appended (it writes the network into the server's database).
// Checks: the heart panel's Network tab draws the map (canvas, stats, a legend of the kinds present); hovering a thing
// shows what it is; the zoom buttons and a legend kind work; a search finds a thing by its other-language name and
// selecting it shows its facts with their page and exact quote; a neighbour opens; the filters and fading switch; full
// screen opens with the details beside the map and closes; pinning a node is saved. The Study tab lists the finished study (her
// notes, open questions) and the running one (what she searched and read, live), takes a new topic and a page, and the
// curiosity setting is saved. Screenshots: en / ko, dark / light, desktop / phone.
"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { chromium } = require("playwright-core");

const [SERVER, PASSWORD, SHOTS, SEED] = process.argv.slice(2);
if (!SERVER || !PASSWORD || !SHOTS || !SEED) {
  console.error("usage: node memory-network-browser.js <server url> <password> <shots dir> <seed command>");
  process.exit(2);
}
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`• ${new Date().toISOString().slice(11, 19)} ${s}`);

async function until(what, fn, ms = 20000, every = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(every);
  }
  throw new Error(`timed out: ${what}`);
}

async function device(browser, { lang = "ko", theme = "dark", phone = false, mateId = "" } = {}) {
  const ctx = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 940 },
    deviceScaleFactor: phone ? 2 : 1,
    isMobile: phone,
    hasTouch: phone,
    colorScheme: theme,
  });
  const r = await ctx.request.post(SERVER + "/api/auth/login", { data: { username: "admin", password: PASSWORD } });
  assert.ok(r.ok(), "login");
  await ctx.addInitScript(([l, th, m]) => {
    try {
      localStorage.setItem("hrh_lang", l);
      localStorage.setItem("hrh_theme", th);
      localStorage.setItem("hrh_setup_completed_v1", "1");
      if (m) localStorage.setItem("hrh_mate_active", m);
    } catch {}
  }, [lang, theme, mateId]);
  return ctx;
}

async function api(ctx, method, url, body) {
  const r = await ctx.request.fetch(SERVER + url, { method, data: body, headers: { "Content-Type": "application/json" } });
  const t = await r.text();
  return { status: r.status(), body: t ? JSON.parse(t) : null };
}

const shot = async (page, name, el) => {
  const file = path.join(SHOTS, `${name}.png`);
  if (el) await page.locator(el).first().screenshot({ path: file });
  else await page.screenshot({ path: file });
  console.log(`  shot ${name}`);
};

async function openPanel(page, tab) {
  await page.goto(`${SERVER}/?view=mate`);
  await page.click('[data-testid=\"mate-status-open\"]'); await page.click('[data-testid=\"stage-status-more\"]');
  await page.click(`[data-testid="stage-status-tab-${tab}"]`);
}

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
  try {
    const setup = await device(browser);
    step("a mate, the user's memories, a seeded network");
    const mate = (await api(setup, "POST", "/api/mates", { name: "하린" })).body;
    await setup.close();
    const ctx = await device(browser, { mateId: mate.id });
    for (const text of ["사용자는 패스 오브 엑자일 2를 자주 한다", "여동생 민지는 간호사다", "사용자의 고향은 부산이다"])
      assert.equal((await api(ctx, "POST", `/api/mates/${mate.id}/memories`, { text, kind: "fact" })).status, 200);
    console.log("  " + execSync(`${SEED} ${mate.id}`).toString().trim());
    const snap = (await api(ctx, "GET", `/api/mates/${mate.id}/graph`)).body;
    assert.ok(snap.nodes.length >= 7 && snap.links.length >= 5, JSON.stringify(snap.stats));

    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    step("the Network tab draws her map");
    await openPanel(page, "network");
    await page.waitForSelector('[data-testid="memory-network"] canvas');
    await until("stats", async () => /\d/.test(await page.innerText('[data-testid="memory-graph-stats"]')));
    await sleep(1800); // (the layout settles)
    await shot(page, "01-network-dark-ko");

    step("hovering a thing shows what it is; zoom; a legend kind");
    const box = await page.locator('[data-testid="memory-network"] canvas').boundingBox();
    const tip = await until("tooltip", async () => {
      for (let y = 0.15; y < 0.9; y += 0.06)
        for (let x = 0.1; x < 0.9; x += 0.04) {
          await page.mouse.move(box.x + box.width * x, box.y + box.height * y);
          if (await page.locator('[data-testid="memory-graph-tooltip"]').count()) return page.innerText('[data-testid="memory-graph-tooltip"]');
        }
      return null;
    }, 30000, 10);
    assert.ok(/생생함|또렷함|흐려지는 중|희미함/.test(tip), tip);
    await shot(page, "01b-tooltip-dark-ko", '[data-testid="memory-network"]');
    await page.mouse.move(box.x - 40, box.y - 40);
    await page.click('[data-testid="memory-graph-zoom-in"]');
    await page.click('[data-testid="memory-graph-zoom-out"]');
    await page.click('[data-testid="memory-graph-fit"]');
    assert.ok(await page.locator('[data-testid="memory-graph-kind-game"]').count(), "the game kind is in the legend");
    assert.equal(await page.locator('[data-testid="memory-graph-kind-work"]').count(), 0, "kinds not on the map stay out of the legend");
    await page.click('[data-testid="memory-graph-kind-event"]');
    assert.equal(await page.getAttribute('[data-testid="memory-graph-kind-event"]', "aria-pressed"), "true");
    await sleep(300);
    await shot(page, "01c-kind-event-dark-ko", '[data-testid="memory-network"]');
    await page.click('[data-testid="memory-graph-kind-event"]');

    step("a search finds it by its other-language name; its facts show their page and quote");
    await page.fill('[data-testid="memory-graph-search"]', "엑자일");
    await page.waitForSelector('[data-testid="memory-graph-results"]');
    await page.locator('[data-testid="memory-graph-results"] button', { hasText: "Path of Exile 2" }).first().click();
    await page.waitForSelector('[data-testid="memory-node-detail"]');
    await until("facts", async () => (await page.locator('[data-testid="memory-node-fact"]').count()) >= 3);
    const factText = await page.innerText('[data-testid="memory-node-facts"]');
    assert.ok(/12월 11일/.test(factText) && /example\.test|leagues and release/.test(factText), factText);
    await page.locator('[data-testid="memory-node-fact"] button', { hasText: "원문 보기" }).first().click();
    await page.waitForSelector('[data-testid="memory-node-fact"] blockquote');
    await shot(page, "02-node-detail-dark-ko");

    step("a neighbour opens; pinning is saved");
    await page.locator('[data-testid="memory-node-neighbor"]', { hasText: "Grinding Gear Games" }).click();
    await until("GGG opened", async () => (await page.innerText('[data-testid="memory-node-detail"] h3')).includes("Grinding Gear Games"));
    await page.click('[data-testid="memory-node-pin"]');
    await until("pinned", async () => {
      const n = (await api(ctx, "GET", `/api/mates/${mate.id}/graph`)).body.nodes.find((x) => x.name === "Grinding Gear Games");
      return n && n.pinned;
    });

    step("filters, fading, full screen");
    await page.click('[data-testid="memory-graph-origin-personal"]');
    await sleep(600);
    await page.click('[data-testid="memory-graph-origin-all"]');
    await page.click('[data-testid="memory-graph-fade"]');
    await page.click('[data-testid="memory-graph-fade"]');
    await page.click('[data-testid="memory-graph-full"]');
    await page.waitForSelector('[data-testid="memory-graph-fullscreen"] canvas');
    await sleep(1500);
    // (wide: the details sit beside the map)
    const [mapBox, detailBox] = await Promise.all([
      page.locator('[data-testid="memory-graph-fullscreen"] canvas').boundingBox(),
      page.locator('[data-testid="memory-graph-fullscreen"] [data-testid="memory-node-detail"]').boundingBox(),
    ]);
    assert.ok(detailBox.x >= mapBox.x + mapBox.width - 1, JSON.stringify({ mapBox, detailBox }));
    await shot(page, "03-fullscreen-dark-ko");
    await page.click('[data-testid="memory-graph-full-close"]');
    await page.waitForSelector('[data-testid="memory-graph-fullscreen"]', { state: "detached" });

    step("the Study tab: her notes, a running study live, a new topic and a page, curiosity");
    await page.click('[data-testid="stage-status-tab-study"]');
    await page.waitForSelector('[data-testid="study-card"][data-state="done"]');
    await page.locator('[data-testid="study-card"][data-state="done"] button').first().click();
    await page.waitForSelector('[data-testid="study-summary"]');
    assert.ok((await page.innerText('[data-testid="study-summary"]')).includes("Forbidden Rites"));
    await page.locator('[data-testid="study-card"][data-state="running"] button').first().click();
    await until("events", async () => (await page.innerText('[data-testid="study-card"][data-state="running"]')).includes("시즌 보상 정리 중"));
    await shot(page, "04-studies-dark-ko");
    await page.fill('[data-testid="study-topic"]', "젤다의 전설 티어스 오브 더 킹덤");
    await page.click('[data-testid="study-depth-quick"]');
    await page.click('[data-testid="study-submit"]');
    await until("new study", async () => (await api(ctx, "GET", `/api/mates/${mate.id}/studies`)).body.some((s) => s.topic.startsWith("젤다")));
    await page.click('[data-testid="study-mode-url"]');
    await page.fill('[data-testid="study-url"]', "https://example.test/article");
    await page.click('[data-testid="study-submit"]');
    await until("url study", async () => (await api(ctx, "GET", `/api/mates/${mate.id}/studies`)).body.some((s) => s.kind === "url"));
    await page.selectOption('[data-testid="study-curiosity"] select', "often");
    await until("curiosity saved", async () => (await api(ctx, "GET", `/api/mates/${mate.id}`)).body.prefs.memory.curiosity === "often");
    assert.deepEqual(errors, [], "no page errors");
    await ctx.close();

    for (const [lang, theme, phone] of [["en", "light", false], ["ko", "light", true], ["en", "dark", true]]) {
      const c = await device(browser, { lang, theme, phone, mateId: mate.id });
      const p = await c.newPage();
      const tag = `${theme}-${lang}${phone ? "-phone" : ""}`;
      await openPanel(p, "network");
      await p.waitForSelector('[data-testid="memory-network"] canvas');
      await sleep(1500);
      await shot(p, `10-network-${tag}`);
      await p.click('[data-testid="stage-status-tab-study"]');
      await p.waitForSelector('[data-testid="study-card"]');
      await shot(p, `11-study-${tag}`);
      step(`screens: ${tag}`);
      await c.close();
    }
    console.log("OK — memory network UI");
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
