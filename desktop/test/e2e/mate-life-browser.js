// Her own day in a real browser (docs/mate-life.md): the world behind her, her status, and her menu on the stage (Status, Places,
// Outfits) with its windows over her on a desk and as sheets on a phone.
//   node mate-life-browser.js <url> <password> [<screenshot dir>]
const { chromium } = require("playwright-core");
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
const T = (id) => `[data-testid="${id}"]`;

/** nothing sticks out sideways: a window must fit whatever is inside it */
async function noSideways(page, sel) {
  return page.evaluate((s) => {
    const root = document.querySelector(s);
    if (!root) return "no " + s;
    const r = root.getBoundingClientRect();
    const out = [];
    for (const el of root.querySelectorAll("*")) {
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      if (el.closest("[data-testid=life-map]") && el.tagName !== "IMG") continue; // (a pin may sit over the edge of the picture)
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
  page.mateId = mate.id;
  await page.goto(`${url}/?view=mate`);
  await page.locator(T("mate-view")).waitFor({ timeout: 30000 });
  return page;
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
  try {
    // ---- on a desk
    const desk = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await goToMate(desk);
    const mateId = page.mateId;
    await until("her day to start and her world to show", async () => {
      if ((await page.locator(T("mate-life-backdrop")).count()) > 0) return true;
      await page.request.get(url + "/api/mates").catch(() => {});
      return false;
    }, 90000);
    const art = await page.locator(T("mate-life-backdrop")).getAttribute("data-art");
    ok("she stands in a place, at this time of day", /places\/[a-z]+-(morning|day|evening|night)\.webp$/.test(art), art);
    ok("the picture really loaded", await page.evaluate(() => [...document.querySelectorAll(".life-backdrop-pic")].some((i) => i.complete && i.naturalWidth > 0)));
    ok("her status is on the stage", await page.locator(T("mate-life-where")).isVisible());
    ok("no condition chip on the stage (it is in her Status)", (await page.locator(T("mate-life-needs")).count()) === 0);
    ok("her menu: status, places, outfits", (await page.locator(`${T("stage-menu")} button`).count()) === 3);
    const stageBox = await page.locator(T("mate-stage")).boundingBox();
    const menuBox = await page.locator(T("stage-menu")).boundingBox();
    ok("the menu sits at the stage's top right", menuBox.x + menuBox.width <= stageBox.x + stageBox.width && menuBox.x > stageBox.x + stageBox.width * 0.75 && menuBox.y < stageBox.y + 40, JSON.stringify({ menuBox, stageBox }));
    ok("no header button for her day any more", (await page.locator(T("mate-life-open")).count()) === 0);
    if (shots) await page.screenshot({ path: shots + "/life-desk.png" });

    // Status
    await page.locator(T("stage-menu-status")).click();
    await page.locator(T("stage-status")).waitFor();
    const win = await page.locator(T("stage-status")).boundingBox();
    ok("the window opens over her, inside the stage", win.x >= stageBox.x && win.x + win.width <= stageBox.x + stageBox.width && win.y >= stageBox.y, JSON.stringify({ win, stageBox }));
    await page.locator(T("stage-status-bond")).waitFor();
    await page.locator(T("life-needs")).waitFor();
    for (const n of ["hunger", "sleep", "affection", "fun", "stress"]) ok("the status shows " + n, await page.locator(T(`life-need-${n}`)).isVisible());
    ok("words, never numbers", !/\d/.test(await page.locator(T("life-needs")).innerText()));
    if (shots) await page.screenshot({ path: shots + "/stage-status.png" });
    await page.locator(T("stage-status-tab-plan")).click();
    await page.locator(T("life-plan-select-sat_day")).waitFor();
    ok("nine slots of the week", (await page.locator('[data-testid^="life-plan-select-"]').count()) === 9);
    await page.locator(T("life-plan-select-sat_day")).selectOption("workout");
    await until("the suggestion to stay", async () => (await (await page.request.get(`${url}/api/mates/${mateId}/life`)).json()).plan.week.sat_day === "workout");
    ok("a suggestion is kept", true);
    await page.locator(T("stage-status-tab-gifts")).click();
    await page.locator(T("life-gift-letter")).waitFor();
    const coins = async () => Number((await page.locator(T("life-coins-n")).innerText()).replace(/[^\d]/g, ""));
    const before = await coins();
    await page.locator(T("life-send-letter")).click();
    await until("the coins to go", async () => (await coins()) === before - 50);
    ok("a gift is sent and paid for", true);
    await page.locator(T("stage-status-tab-growth")).click();
    ok("what she is growing in shows", (await page.locator('[data-testid^="life-stat-"]').count()) === 6);
    await page.locator(T("stage-status-tab-journal")).click();
    await page.locator(T("life-journal-empty")).waitFor();
    ok("the journal starts empty", true);
    await page.keyboard.press("Escape");
    await until("the window to close", async () => (await page.locator(T("stage-status")).count()) === 0);
    ok("Escape closes it", true);

    // Places
    await page.locator(T("stage-menu-places")).click();
    await page.locator(`${T("life-map")} img`).waitFor();
    ok("the map has her neighbourhood", (await page.locator('[data-testid^="life-pin-"]').count()) >= 9);
    await page.locator(T("life-pin-park")).click();
    await page.locator(T("life-place-detail-park")).waitFor();
    ok("a pin chooses a place and shows it", await page.locator(T("life-place-detail-park")).isVisible());
    if (shots) await page.screenshot({ path: shots + "/stage-places.png" });
    await page.locator(T("stage-places-close")).click();

    // Outfits
    await page.locator(T("stage-menu-outfits")).click();
    await page.locator(T("stage-outfit-grid")).waitFor();
    const tiles = await page.locator(T("stage-outfit")).count();
    ok("her wardrobe", tiles >= 3, String(tiles));
    await page.locator(`${T("stage-outfit")}[data-outfit="builtin-linen-dress"]`).click();
    await page.locator(T("stage-outfit-wear")).click();
    await until("the dress on", async () => (await (await page.request.get(`${url}/api/mates`)).json()).find((m) => m.id === mateId).outfits.worn === "builtin-linen-dress");
    ok("what she has on changes from the stage", true);
    if (shots) await page.screenshot({ path: shots + "/stage-outfits.png" });
    await page.locator(`${T("stage-outfit")}[data-outfit="default"]`).click();
    await page.locator(T("stage-outfit-wear")).click();
    await until("back in her hoodie", async () => (await (await page.request.get(`${url}/api/mates`)).json()).find((m) => m.id === mateId).outfits.worn === "default");
    await page.keyboard.press("Escape");

    // her clip library: stills only, a click plays the one clip in a window
    await page.locator(T("mate-settings-open")).click();
    await page.locator(T("mate-tab-avatar")).click();
    await page.locator(T("mate-clip-library")).waitFor();
    await page.locator('[data-testid^="mate-clip-card-"] img').first().waitFor();
    const cards = await page.locator('[data-testid^="mate-clip-card-"]').count();
    const stills = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="mate-clip-card-"] img')].filter((i) => /\.thumb\.webp/.test(i.src)).length);
    ok("every clip card is a still made with the set", cards >= 14 && stills === cards, `${stills}/${cards}`);
    ok("no clip plays in the library", (await page.evaluate(() => document.querySelectorAll('[data-testid="mate-clip-library"] canvas, [data-testid="mate-clip-library"] video').length)) === 0);
    await page.locator('[data-testid="mate-clip-card-idle_a"]').hover();
    await page.waitForTimeout(400);
    ok("hovering plays nothing", (await page.evaluate(() => document.querySelectorAll('[data-testid="mate-clip-library"] canvas').length)) === 0);
    await page.locator('[data-testid="mate-clip-card-idle_a"]').click();
    await page.locator(T("mate-clip-dialog")).waitFor();
    ok("a click opens the clip in a window, with its settings", await page.locator(`${T("mate-clip-dialog")} ${T("mate-clip-editor")}`).isVisible());
    ok("one player, in the window", (await page.evaluate(() => document.querySelectorAll('[data-testid="mate-clip-editor-stage"]').length)) === 1);
    if (shots) await page.waitForTimeout(500), await page.screenshot({ path: shots + "/clip-dialog.png" });
    await page.keyboard.press("Escape");
    await until("the clip window to close", async () => (await page.locator(T("mate-clip-dialog")).count()) === 0);
    ok("no script errors on a desk", page.errors.length === 0, page.errors.join("\n"));
    await desk.close();

    // ---- on a phone
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const p = await goToMate(phone);
    await p.locator(T("mate-life-backdrop")).waitFor();
    const box = await p.locator(T("mate-stage")).boundingBox();
    const hud = await p.locator(T("mate-life-hud")).boundingBox();
    const menu = await p.locator(T("stage-menu")).boundingBox();
    ok("on a phone her status stays inside the stage", hud.y + hud.height <= box.y + box.height + 1 && hud.x >= box.x && hud.x + hud.width <= box.x + box.width + 1, JSON.stringify({ hud, box }));
    ok("and so does her menu, clear of her status", menu.y >= box.y && menu.y + menu.height <= hud.y && menu.x + menu.width <= box.x + box.width + 1, JSON.stringify({ menu, hud, box }));
    if (shots) await p.screenshot({ path: shots + "/life-phone.png" });
    await p.locator(T("stage-menu-status")).click();
    await p.locator(T("stage-status")).waitFor();
    for (const tab of ["now", "plan", "growth", "journal", "gifts"]) {
      await p.locator(T(`stage-status-tab-${tab}`)).click();
      await p.waitForTimeout(250);
      const out = await noSideways(p, T("stage-status"));
      ok(`the ${tab} tab fits a phone`, !out, out);
      if (shots) await p.waitForTimeout(300), await p.screenshot({ path: `${shots}/phone-status-${tab}.png` });
    }
    await p.locator(T("stage-status-close")).click();
    await until("the sheet to close", async () => (await p.locator(T("stage-status")).count()) === 0);
    await p.locator(T("stage-menu-places")).click();
    await p.locator(T("life-places")).waitFor();
    ok("the places fit a phone", !(await noSideways(p, T("stage-places"))), await noSideways(p, T("stage-places")));
    if (shots) await p.screenshot({ path: shots + "/phone-places.png" });
    const open = await p.evaluate(() => [...document.querySelectorAll('[data-testid^="life-place-"]')].map((e) => e.getAttribute("data-testid")).filter((x) => !x.includes("detail")));
    let invited = false;
    for (const id of open) {
      await p.locator(T(id)).click();
      const key = id.replace("life-place-", "");
      const btn = p.locator(T(`life-invite-${key}`));
      if ((await btn.count()) && (await btn.isEnabled())) {
        await btn.click();
        invited = true;
        break;
      }
    }
    if (invited) {
      await until("the sheet to close", async () => (await p.locator(T("stage-places")).count()) === 0);
      await until("the invitation to be said", async () => /같이|together|가자/.test(await p.locator(T("mate-conversation")).innerText()));
      ok("asking her along is a message like any other", true);
    } else ok("(every place is closed at this hour: nothing to ask her along to)", true);
    await p.locator(T("stage-menu-outfits")).click();
    await p.locator(T("stage-outfit-grid")).waitFor();
    ok("the wardrobe fits a phone", !(await noSideways(p, T("stage-outfits"))), await noSideways(p, T("stage-outfits")));
    if (shots) await p.waitForTimeout(400), await p.screenshot({ path: shots + "/phone-outfits.png" });
    ok("no script errors on a phone", p.errors.length === 0, p.errors.join("\n"));
    await phone.close();
    console.log("OK: her own day");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
