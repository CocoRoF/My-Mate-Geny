// 메이트 편집 (docs/avatar-create.md §11): the Mate view's header in its order, Mate settings with only what isn't her
// (관계와 기억 · 공통 · 삭제) and the way to 메이트 편집, the studio's Guide | AI tabs, a node's window in the middle of the
// screen (asking before unsaved settings are thrown away), her look from a file — a Live2D model in a zip: imported, fitted,
// its expressions and motions looked through and matched to her emotions, saved by itself — the canvas turning to the file
// branch, a new mate made step by step in the Guide, and the phone's Guide | Canvas | AI. In a browser against a throwaway
// server (any: the built frontend, admin + its password, a Live2D runtime installed for the preview):
//
//   NODE_PATH=<dir with playwright-core> CHROME=<chromium binary> \
//     node desktop/test/e2e/mate-edit-guide-browser.js http://127.0.0.1:18099 <password> <shots dir> <live2d model .zip>
const assert = require("assert/strict");
const fs = require("fs");
const { chromium } = require("playwright-core");

const [BASE, PASSWORD, OUT, MODEL] = process.argv.slice(2);
if (!BASE || !PASSWORD || !OUT || !MODEL) {
  console.error("usage: node mate-edit-guide-browser.js <server url> <password> <shots dir> <live2d model .zip>");
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
const theme = process.env.THEME || "dark";

(async () => {
const b = await chromium.launch({ executablePath: process.env.CHROME || undefined });
const errors = [];
const ctx = await b.newContext({ locale: "ko-KR", viewport: { width: 1440, height: 900 }, colorScheme: theme });
const p = await ctx.newPage();
p.on("pageerror", (e) => errors.push(e.message));
p.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text().slice(0, 200)));
await ctx.request.post(`${BASE}/api/auth/login`, { data: { username: "admin", password: PASSWORD } });
await ctx.request.put(`${BASE}/api/preferences`, { data: { language: "ko", theme } });
const shot = async (name, opts = {}) => {
  await p.waitForTimeout(opts.wait ?? 700);
  await p.screenshot({ path: `${OUT}/${theme}-${name}.png`, ...(opts.clip ? { clip: opts.clip } : {}) });
};
await p.goto(`${BASE}/`);
await p.getByTestId("setup-later").click({ timeout: 8000 }).catch(() => {});
await p.goto(`${BASE}/?view=mate`);
await p.getByTestId("mate-view").waitFor({ timeout: 15000 });
await p.waitForTimeout(2000);
// 1 · the header, in order
const order = await p.evaluate(() => {
  const ids = ["mate-edit", "mate-reset", "mate-call", "mate-layout", "mate-status-open", "mate-settings-open"];
  return [...document.querySelectorAll("[data-testid]")].map((e) => e.getAttribute("data-testid")).filter((x) => ids.includes(x));
});
console.log("header order:", order.join(" > "));
assert.deepEqual(order.filter((x) => x !== "mate-call"), ["mate-edit", "mate-reset", "mate-layout", "mate-status-open", "mate-settings-open"]);
await shot("1-header", { clip: { x: 700, y: 0, width: 740, height: 70 } });
// 2 · Mate settings: only relationship / common / delete, and the way to 메이트 편집
await p.getByTestId("mate-settings-open").click();
await p.getByTestId("mate-settings").waitFor();
const tabs = await p.$$eval("[data-testid^=mate-tab-]", (els) => els.map((e) => e.getAttribute("data-testid")));
assert.deepEqual(tabs, ["mate-tab-bond", "mate-tab-common", "mate-tab-danger"]);
assert.equal(await p.getByTestId("mate-settings-edit").count(), 1);
await shot("2-settings");
// 3 · 메이트 편집 from the card
await p.getByTestId("mate-settings-edit").click();
await p.getByTestId("mate-studio").waitFor({ timeout: 15000 });
await p.getByTestId("studio-guide").waitFor({ timeout: 20000 });
console.log("studio title:", await p.getByTestId("studio-title").textContent(), "| guide mode:", await p.getByTestId("studio-guide").getAttribute("data-mode"));
await shot("3-edit", { wait: 2500 });
// 4 · a step → its window in the middle
await p.getByTestId("guide-step-profile-toggle").click();
await p.getByTestId("guide-profile-open").click();
await p.getByTestId("node-sheet").waitFor();
const box = await p.getByTestId("node-sheet").boundingBox();
console.log("profile window:", JSON.stringify(box));
await shot("4-profile-window");
// unsaved change → asked before closing
await p.locator('[data-testid="node-sheet"] input').first().fill("서아 테스트");
await p.getByTestId("node-sheet-close").click();
const asked = await p.getByTestId("confirm-dialog").isVisible().catch(() => false);
assert.ok(asked, "asked before losing changes");
await shot("4b-unsaved");
if (asked) await p.getByTestId("confirm-ok").click();
await p.getByTestId("node-sheet").waitFor({ state: "detached" });
// 5 · temperament from the canvas
await p.locator('[data-testid="sc-node-temperament"] .scn-hit').click();
await p.getByTestId("node-sheet").waitFor();
await shot("5-temperament", { wait: 1500 });
await p.keyboard.press("Escape");
await p.getByTestId("node-sheet").waitFor({ state: "detached" });
// 6 · the AI tab
await p.getByTestId("studio-side-agent").click();
await shot("6-ai");
await p.getByTestId("studio-side-guide").click();
// 7 · her look from a file: Live2D
await p.getByTestId("guide-step-look-toggle").click();
await shot("7-look-choose");
if (await p.getByTestId("look-file").count()) await p.getByTestId("look-file").click();
else console.log("look: already from a file (no chooser)");
await shot("7b-file-steps");
await p.getByTestId((await p.getByTestId("guide-file-open").count()) ? "guide-file-open" : "guide-file-other").click();
await p.getByTestId("look-import").waitFor();
await shot("7c-import-empty");
await p.waitForTimeout(500);
await p.getByTestId("look-file-input").setInputFiles(MODEL);
if (await p.getByTestId("confirm-dialog").isVisible({ timeout: 3000 }).catch(() => false)) {
  await shot("7d-replace-confirm");
  await p.getByTestId("confirm-ok").click();
}
await p.locator('[data-testid="look-import"][data-kind="live2d"]').waitFor({ timeout: 60000 });
console.log("import:", await p.getByTestId("look-import-counts").textContent().catch(() => "?"), "| done:", await p.getByTestId("look-import-done").textContent().catch(() => "-"));
await shot("8-imported", { wait: 3500 });
await p.getByTestId("look-scale").fill("1.1");
await shot("8b-scaled", { wait: 1500 });
await p.getByTestId("look-import-next").click();
await p.getByTestId("look-mapper").waitFor();
await shot("9-mapper", { wait: 3000 });
await p.getByTestId("look-browse-face").nth(2).click();
await shot("9b-browse-face", { wait: 1500 });
await p.getByTestId("look-browse-motion").nth(1).click();
await shot("9c-browse-motion", { wait: 1500 });
await p.getByTestId("look-map-joy-face").selectOption("exp_03");
await p.getByTestId("look-map-joy-motion").selectOption("Tap");
await shot("9d-mapped", { wait: 1800 });
console.log("count:", await p.getByTestId("look-mapper-count").textContent(), "| save:", await p.getByTestId("look-save-state").textContent().catch(() => "-"));
await p.getByTestId("look-mapper-done").click();
await p.getByTestId("node-sheet").waitFor({ state: "detached" });
await shot("10-canvas-file", { wait: 2000 });
const m = (await (await ctx.request.get(`${BASE}/api/mates`)).json());
const list = Array.isArray(m) ? m : m.mates;
const her = list.find((x) => x.avatar?.kind === "live2d");
assert.equal(her?.avatar?.live2d?.emotions?.joy, "exp_03");
assert.equal(her?.avatar?.live2d?.emotion_motions?.joy, "Tap");
assert.equal(her?.avatar?.live2d?.scale, 1.1);
// 11 · a new mate, step by step
await p.goto(`${BASE}/?view=mate&create=new`);
await p.locator('[data-testid="studio-guide"][data-mode="create"]').waitFor({ timeout: 20000 });
await shot("11-new", { wait: 2000 });
await p.locator('[data-testid="guide-concept-examples"] button').first().click();
await p.waitForTimeout(800);
await p.getByTestId("guide-concept-next").click();
await p.getByTestId("guide-name").fill("하린");
await p.getByTestId("guide-personality").fill("다정하고 장난기 많아요");
await p.waitForTimeout(1500);
await shot("12-profile");
await p.getByTestId("guide-profile-next").click();
await p.getByTestId("guide-formality").locator("button").nth(1).click().catch(() => {});
await shot("13-style");
await p.getByTestId("guide-style-next").click();
await shot("14-temperament");
await p.getByTestId("guide-temperament-keep").click();
await shot("15-look");
await p.getByTestId("look-later").click();
await p.waitForTimeout(1200);
await shot("16-look-later");
await p.getByTestId("guide-look-next").click().catch(() => {});
await shot("17-voice");
await p.getByTestId("guide-voice-next").click();
await p.getByTestId("guide-model-keep").click();
await shot("18-finish", { wait: 1200 });
assert.equal(await p.getByTestId("studio-guide").getAttribute("data-step"), "finish");
assert.ok(await p.getByTestId("guide-create").isEnabled(), "Create is ready");
// 12 · phone
const ph = await b.newContext({ locale: "ko-KR", viewport: { width: 390, height: 844 }, colorScheme: theme, hasTouch: true, isMobile: true });
const q = await ph.newPage();
q.on("pageerror", (e) => errors.push("phone: " + e.message));
await ph.request.post(`${BASE}/api/auth/login`, { data: { username: "admin", password: PASSWORD } });
await q.goto(`${BASE}/`);
await q.getByTestId("setup-later").click({ timeout: 8000 }).catch(() => {});
await q.goto(`${BASE}/?view=mate`);
await q.getByTestId("mate-view").waitFor({ timeout: 15000 });
await q.waitForTimeout(1500);
await q.screenshot({ path: `${OUT}/${theme}-20-phone-header.png`, clip: { x: 0, y: 0, width: 390, height: 120 } });
await q.getByTestId("mate-more").click();
await q.waitForTimeout(400);
await q.screenshot({ path: `${OUT}/${theme}-21-phone-more.png` });
await q.locator('[data-testid="mate-more-menu"] [data-testid="mate-edit"]').click();
await q.getByTestId("studio-guide").waitFor({ timeout: 20000 });
await q.waitForTimeout(1500);
await q.screenshot({ path: `${OUT}/${theme}-22-phone-guide.png` });
await q.getByTestId("guide-step-voice-toggle").click();
await q.getByTestId("guide-voice-open").click();
await q.getByTestId("node-sheet").waitFor();
await q.waitForTimeout(800);
await q.screenshot({ path: `${OUT}/${theme}-23-phone-window.png` });
await q.getByTestId("node-sheet-close").click();
await q.getByTestId("studio-tab-canvas").click();
await q.waitForTimeout(1200);
await q.screenshot({ path: `${OUT}/${theme}-24-phone-canvas.png` });
await b.close();
// (429s are the throwaway server's login limit)
assert.deepEqual(errors.filter((e) => !/429/.test(e)), [], "no page errors");
console.log("OK");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
