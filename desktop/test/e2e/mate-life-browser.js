// Her own day in a real browser (docs/mate-life.md): the world behind her, her status, the Life panel, on a desk and on a phone.
//   node mate-life-browser.js <url> <password> [<screenshot dir>]
const { chromium } = require("playwright-core");
const fs = require("fs");
const [url, password, shots] = process.argv.slice(2);
const until = async (what, fn, ms = 15000) => {
  const start = Date.now();
  for (;;) {
    const got = await fn();
    if (got) return got;
    if (Date.now() - start > ms) throw new Error("timed out: " + what);
    await new Promise((r) => setTimeout(r, 150));
  }
};
const ok = (what, cond, more = "") => {
  if (!cond) throw new Error("FAILED: " + what + " " + more);
  console.log("• " + what);
};

/** nothing sticks out sideways: the panel must fit whatever is inside it */
async function noSideways(page, sel) {
  return page.evaluate((s) => {
    const root = document.querySelector(s);
    if (!root) return "no " + s;
    const r = root.getBoundingClientRect();
    const out = [];
    for (const el of root.querySelectorAll("*")) {
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      if (el.closest("[data-testid=life-map]") && el.tagName === "SPAN") continue; // (a pin may sit over the edge of the picture)
      if (el.closest(".no-scrollbar")) continue; // (tabs scroll on their own)
      if (b.right > r.right + 1 || b.left < r.left - 1) out.push(el.tagName + "." + String(el.className).slice(0, 50));
    }
    return out.length ? out.slice(0, 6).join(" | ") : "";
  }, sel);
}

async function goToMate(ctx) {
  const login = await ctx.request.post(`${url}/api/auth/login`, { data: { username: "admin", password } });
  if (!login.ok()) throw new Error("login");
  const mate = (await (await ctx.request.get(`${url}/api/mates`)).json()).find((m) => m.builtin === "chaerin");
  await ctx.addInitScript(
    (id) => {
      localStorage.setItem("hrh_lang", "ko");
      localStorage.setItem("hrh_theme", "dark");
      localStorage.setItem("hrh_setup_seen_v2", "1");
      localStorage.setItem("hrh_mate_muted", "1");
      localStorage.setItem("hrh_mate_active", id);
    },
    mate.id,
  );
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.errors = errors;
  await page.goto(`${url}/?view=mate`);
  await page.locator('[data-testid="mate-view"]').waitFor({ timeout: 30000 });
  return page;
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
  try {
    // ---- on a desk
    const desk = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await goToMate(desk);
    const errors = page.errors;
    const stage = page.locator('[data-testid="mate-stage"]');
    await until("her day to start and her world to show", async () => {
      if ((await page.locator('[data-testid="mate-life-backdrop"]').count()) > 0) return true;
      await page.request.get(url + "/api/mates").catch(() => {});
      return false;
    }, 90000);
    const art = await page.locator('[data-testid="mate-life-backdrop"]').getAttribute("data-art");
    ok("she stands in a place, at this time of day", /places\/[a-z]+-(morning|day|evening|night)\.webp$/.test(art), art);
    const loaded = await page.evaluate(() => [...document.querySelectorAll(".life-backdrop-pic")].some((i) => i.complete && i.naturalWidth > 0));
    ok("the picture really loaded", loaded);
    ok("her status is on the stage", await page.locator('[data-testid="mate-life-where"]').isVisible());
    ok("and how she is doing", (await page.locator('[data-testid="mate-life-needs"] > span').count()) === 5);
    if (shots) await page.screenshot({ path: shots + "/life-desk.png" });

    await page.locator('[data-testid="mate-life-hud"]').click();
    await page.locator('[data-testid="mate-life-panel"]').waitFor();
    await page.locator('[data-testid="life-now-card"]').waitFor();
    ok("a tap opens her day", true);
    for (const n of ["hunger", "sleep", "affection", "fun", "stress"]) ok("the panel shows " + n, await page.locator(`[data-testid="life-need-${n}"]`).isVisible());
    const text = await page.locator('[data-testid="life-needs"]').innerText();
    ok("words, never numbers", !/\d/.test(text), text);
    if (shots) await page.screenshot({ path: shots + "/life-panel-now.png" });

    await page.locator('[data-testid="life-tab-map"]').click();
    await page.locator('[data-testid="life-map"] img').waitFor();
    ok("the map has her neighbourhood", (await page.locator('[data-testid^="life-pin-"]').count()) >= 9);
    ok("the street isn't a place to go", (await page.locator('[data-testid="life-place-street"]').count()) === 0);
    if (shots) await page.screenshot({ path: shots + "/life-panel-map.png" });

    await page.locator('[data-testid="life-tab-gifts"]').click();
    await page.locator('[data-testid="life-gift-letter"]').waitFor();
    const coins = async () => Number((await page.locator('[data-testid="life-coins-n"]').innerText()).replace(/[^\d]/g, ""));
    const before = await coins();
    await page.locator('[data-testid="life-send-letter"]').click();
    await until("the coins to go", async () => (await coins()) === before - 50);
    ok("a gift is sent and paid for", true);
    if (shots) await page.screenshot({ path: shots + "/life-panel-gifts.png" });
    await until("the letter to be hers", async () => /있|has/.test(await page.locator('[data-testid="life-send-letter"]').innerText()));
    ok("something she keeps can't be sent twice", await page.locator('[data-testid="life-send-letter"]').isDisabled());

    await page.locator('[data-testid="life-tab-growth"]').click();
    await page.locator('[data-testid="life-stat-gaming"]').waitFor();
    ok("what she is growing in shows", (await page.locator('[data-testid^="life-stat-"]').count()) === 6);
    if (shots) await page.screenshot({ path: shots + "/life-panel-growth.png" });

    await page.locator('[data-testid="mate-life-panel-close"]').click();
    ok("the header button is there too", await page.locator('[data-testid="mate-life-open"]').isVisible());
    ok("no script errors on a desk", errors.length === 0, errors.join("\n"));
    await desk.close();

    // ---- on a phone
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const p = await goToMate(phone);
    await p.locator('[data-testid="mate-life-backdrop"]').waitFor();
    const box = await p.locator('[data-testid="mate-stage"]').boundingBox();
    const hud = await p.locator('[data-testid="mate-life-hud"]').boundingBox();
    ok("on a phone her status stays inside the stage", hud.y + hud.height <= box.y + box.height + 1 && hud.x >= box.x && hud.x + hud.width <= box.x + box.width + 1, JSON.stringify({ hud, box }));
    if (shots) await p.screenshot({ path: shots + "/life-phone.png" });
    await p.locator('[data-testid="mate-life-open"]').click();
    await p.locator('[data-testid="life-now-card"]').waitFor();
    for (const tab of ["now", "map", "gifts", "growth"]) {
      await p.locator(`[data-testid="life-tab-${tab}"]`).click();
      await p.waitForTimeout(250);
      ok(`the ${tab} tab fits a phone`, !(await noSideways(p, '[data-testid="mate-life-panel"]')), await noSideways(p, '[data-testid="mate-life-panel"]'));
      if (shots) await p.screenshot({ path: `${shots}/life-phone-${tab}.png` });
    }
    await p.locator('[data-testid="life-tab-map"]').click();
    await p.locator('[data-testid="mate-life-panel"] [data-testid="life-places"]').waitFor();
    const invite = p.locator('[data-testid^="life-invite-"]').first();
    await invite.click();
    await until("the panel to close", async () => (await p.locator('[data-testid="mate-life-panel"]').count()) === 0);
    await until("the invitation to be said", async () => /같이|together/.test(await p.locator('[data-testid="mate-conversation"]').innerText()));
    ok("asking her along is a message like any other", true);
    await phone.close();
    console.log("OK: her own day");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
