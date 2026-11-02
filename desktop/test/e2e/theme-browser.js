// Light / dark (Settings → Appearance, frontend/src/lib/theme.ts) in a browser against a real server on THIS machine
// (backend with CLAUDE_BINARY=desktop/test/e2e/fake-claude.py, the frontend build as STATIC_DIR):
//
//   NODE_PATH=<dir with playwright-core> CHROME=<chromium binary> \
//     node test/e2e/theme-browser.js <server url> <password> [shots dir] [checks|shots] [workspace dir]
//
// checks: the pick applies at once and in a second window; a reload draws the theme before the app's code runs (no
//         flash); System follows prefers-color-scheme live; the account's choice reaches another device unless that
//         one keeps its own; the login page follows the cookie / the system.
// shots:  every main screen in light and dark (desktop + phone, English + Korean where words matter) with a contrast
//         audit of the visible text in each (WCAG: 4.5:1, 3:1 for large text) — failures are listed (and fail the run
//         with HRH_STRICT_CONTRAST=1).
"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const [SERVER, PASSWORD, SHOTS, ONLY, WORKSPACE] = process.argv.slice(2);
if (!SERVER || !PASSWORD) {
  console.error("usage: node test/e2e/theme-browser.js <server url> <password> [shots dir] [checks|shots] [workspace]");
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`• ${s}`);
const DESK = { viewport: { width: 1440, height: 900 } };
const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
};

async function api(ctx, method, url, body) {
  const r = await ctx.request.fetch(SERVER + url, { method, data: body, headers: { "Content-Type": "application/json" } });
  const t = await r.text();
  if (!r.ok()) throw new Error(`${method} ${url}: ${r.status()} ${t}`);
  return t ? JSON.parse(t) : null;
}

/** a signed-in device; `theme`: the mode stored on it before any page runs (null: none) */
async function device(browser, { phone = false, lang = "en", theme = null, colorScheme = "dark", login = true } = {}) {
  const ctx = await browser.newContext({ ...(phone ? PHONE : DESK), colorScheme });
  if (login) {
    const r = await ctx.request.post(SERVER + "/api/auth/login", { data: { username: "admin", password: PASSWORD } });
    assert.ok(r.ok(), "login");
  }
  await ctx.addInitScript(
    ([l, th]) => {
      try {
        if (!sessionStorage.getItem("hrh_theme_seeded")) {
          sessionStorage.setItem("hrh_theme_seeded", "1");
          localStorage.setItem("hrh_lang", l);
          if (th) localStorage.setItem("hrh_theme", th);
        }
      } catch {}
    },
    [lang, theme],
  );
  return ctx;
}

const htmlTheme = (page) =>
  page.evaluate(() => ({
    cls: document.documentElement.className,
    theme: document.documentElement.dataset.theme,
    mode: document.documentElement.dataset.themeMode,
    bg: getComputedStyle(document.body).backgroundColor,
  }));

async function until(what, fn, ms = 10000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await fn();
    if (last) return last;
    await sleep(100);
  }
  throw new Error(`timed out: ${what}`);
}

// ── contrast audit: every visible text run against what is painted behind it ──────────────────────────────────────
function auditContrast() {
  const parse = (c) => {
    const m = c && c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const lin = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
  /** the colour painted behind `el` (null: an image / gradient there — can't tell) */
  function backdrop(el) {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== "none" && !/^radial-gradient|^linear-gradient\(45deg/.test(cs.backgroundImage)) {
        if (e === document.body) break; // the page's soft gradient: its base colour below
        return null;
      }
      if (e.tagName === "IMG" || e.tagName === "VIDEO" || e.tagName === "CANVAS") return null;
      const c = parse(cs.backgroundColor);
      if (c && c[3] > 0) {
        layers.push(c);
        if (c[3] >= 1) break;
      }
    }
    let base = parse(getComputedStyle(document.documentElement).backgroundColor);
    if (!base || base[3] < 1) base = document.documentElement.classList.contains("light") ? [241, 243, 247, 1] : [10, 12, 16, 1];
    let col = base;
    for (let i = layers.length - 1; i >= 0; i--) col = over(layers[i], col);
    return col;
  }
  const out = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent.trim();
    if (!text) continue;
    const el = n.parentElement;
    if (!el || seen.has(el)) continue;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    let op = 1;
    for (let e = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
    if (op < 0.98) continue; // faded on purpose (disabled, an animation) — WCAG exempts inactive UI
    if (el.closest("[aria-hidden='true'], .sr-only, canvas, svg, .hljs-view .ln, [data-contrast-skip]")) continue;
    if (cs.webkitTextFillColor && cs.webkitTextFillColor.startsWith("rgba(0, 0, 0, 0)")) continue; // gradient text
    const fg = parse(cs.color);
    if (!fg || fg[3] === 0) continue;
    const bg = backdrop(el);
    if (!bg) continue;
    const ink = fg[3] < 1 ? over(fg, bg) : fg;
    const size = parseFloat(cs.fontSize);
    const bold = Number(cs.fontWeight) >= 700;
    const large = size >= 24 || (bold && size >= 18.66);
    const need = large ? 3 : 4.5;
    const got = ratio(ink, bg);
    if (got < need) out.push({ text: text.slice(0, 40), ratio: Math.round(got * 100) / 100, need, color: cs.color, bg: `rgb(${bg.slice(0, 3).map(Math.round).join(",")})`, where: el.className && typeof el.className === "string" ? el.className.slice(0, 80) : el.tagName });
  }
  return out;
}

const report = [];
async function shot(page, name, { audit = true, full = false } = {}) {
  await sleep(250);
  if (SHOTS) {
    const file = path.join(SHOTS, `${name}.png`);
    await page.screenshot({ path: file, fullPage: full });
  }
  if (audit) {
    const bad = await page.evaluate(auditContrast);
    report.push({ name, bad });
    console.log(`  shot ${name}${bad.length ? `  — ${bad.length} low-contrast text run(s)` : ""}`);
    for (const b of bad.slice(0, 6)) console.log(`      ${b.ratio} < ${b.need}  "${b.text}"  ${b.color} on ${b.bg}  [${b.where}]`);
  } else console.log(`  shot ${name}`);
}

// ── the content the screens show ───────────────────────────────────────────────────────────────────────────────
async function seed(browser) {
  const setup = await device(browser);
  await api(setup, "POST", "/api/providers/claude/connect", { auth_mode: "api_key", api_key: "sk-ant-fake-e2e" }).catch(() => {});
  await api(setup, "PUT", "/api/preferences", { theme: null, language: null });
  const ws = WORKSPACE || path.join(process.env.HOME || "/tmp", ".cache", "hrh-theme-run", "work", "demo");
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "app.py"), "def greet(name: str) -> str:\n    # a friendly hello\n    return f\"hello, {name}!\"\n\nprint(greet('world'))\n");
  fs.writeFileSync(path.join(ws, "README.md"), "# Demo\n\nA **small** project.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1; // one\n```\n");
  const sessions = await api(setup, "GET", "/api/sessions");
  let chat = sessions.find((s) => s.title === "Theme demo");
  if (!chat) {
    chat = await api(setup, "POST", "/api/sessions", { provider: "claude", model: "", connection_id: null, workspace_path: ws, title: "Theme demo" });
    const page = await setup.newPage();
    await page.addInitScript((id) => localStorage.setItem("hrh_last_session", id), chat.id);
    await page.goto(SERVER + "/");
    await page.waitForSelector("textarea", { timeout: 20000 });
    await sleep(2500);
    for (const msg of ["Please fix the greeting in src/app.py tools1", "md1 show me the formatting"]) {
      await page.fill("textarea", msg);
      await page.keyboard.press("Enter");
      await until("reply", async () => !(await page.locator('[data-testid="stop"], button[title="Stop"]').count()) && (await page.evaluate((m) => document.body.innerText.includes(m.includes("md1") ? "마지막으로" : "What changed"), msg)), 60000);
      await sleep(800);
    }
    await page.close();
  }
  let mates = await api(setup, "GET", "/api/mates");
  let mate = mates.find((m) => m.name === "Geny Theme");
  if (!mate) {
    mate = await api(setup, "POST", "/api/mates", { name: "Geny Theme" });
    await api(setup, "PATCH", `/api/mates/${mate.id}`, { voice: { auto_read: false } }).catch(() => {});
    const page = await setup.newPage();
    await page.addInitScript((id) => localStorage.setItem("hrh_mate_id", id), mate.id);
    await page.goto(`${SERVER}/?view=mate&mate=${mate.id}`);
    await page.waitForSelector('[data-testid="mate-settings-open"]', { timeout: 20000 });
    await sleep(1500);
    for (const msg of ["Hi! md2 a quick summary", "and a table md1"]) {
      await page.fill("textarea", msg);
      await page.keyboard.press("Enter");
      await until("mate reply", async () => page.evaluate((m) => document.body.innerText.includes(m.includes("md1") ? "마지막으로" : "끝이에요"), msg), 60000);
      await sleep(600);
    }
    await page.close();
  }
  await setup.close();
  return { chat, mate, ws };
}

// ── shots ────────────────────────────────────────────────────────────────────────────────────────────────────────
async function shots(browser, data) {
  for (const theme of ["light", "dark"]) {
    for (const lang of ["en", "ko"]) {
      const T = `${theme}-${lang}`;
      step(`screens: ${T} (desktop)`);
      const ctx = await device(browser, { theme, lang, colorScheme: theme });
      const page = await ctx.newPage();
      page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
      await page.addInitScript((id) => localStorage.setItem("hrh_last_session", id), data.chat.id);
      // new chat
      await page.goto(SERVER + "/");
      await page.waitForSelector("textarea", { timeout: 20000 });
      await sleep(1200);
      await shot(page, `chat-new-desktop-${T}`);
      // the chat with tool rows, diff, markdown
      await page.goto(`${SERVER}/?view=chat&session=${data.chat.id}`);
      await page.waitForSelector("textarea", { timeout: 20000 });
      await sleep(1500);
      await shot(page, `chat-markdown-desktop-${T}`);
      // scroll up to the tool turn and open the Edit row
      await page.evaluate(() => {
        const el = [...document.querySelectorAll("*")].find((e) => e.scrollHeight > e.clientHeight + 50 && /auto|scroll/.test(getComputedStyle(e).overflowY) && e.clientHeight > 300);
        if (el) el.scrollTop = 0;
      });
      await sleep(400);
      for (const label of ["Edit", "Run the tests", "실행", "편집"]) {
        const row = page.locator(`button:has(span:text-is("${label}"))`).first();
        if (await row.count()) await row.click().catch(() => {});
      }
      await sleep(400);
      await shot(page, `chat-tools-desktop-${T}`);
      // a menu (the model / mode chips above the composer)
      const chip = page.locator('button:has-text("Claude Opus"), button:has-text("Agent")').first();
      if (await chip.count()) {
        await chip.click().catch(() => {});
        await sleep(500);
        await shot(page, `chat-menu-desktop-${T}`);
        await page.keyboard.press("Escape");
        await sleep(300);
      }
      if (lang === "en") {
        // the explorer + a file
        const explorer = page.locator('[data-testid="explorer-toggle"], button[title*="xplorer"], button[aria-label*="xplorer"]').first();
        if (await explorer.count()) {
          await explorer.click().catch(() => {});
          await sleep(900);
          const f = page.locator('text="README.md"').first();
          if (await f.count()) {
            await f.click().catch(() => {});
            await sleep(1200);
          }
          await shot(page, `explorer-file-desktop-${T}`);
          const py = page.locator('text="src"').first();
          if (await py.count()) {
            await py.click().catch(() => {});
            await sleep(500);
            await page.locator('text="app.py"').first().click().catch(() => {});
            await sleep(1200);
            await shot(page, `explorer-code-desktop-${T}`);
          }
        }
      }
      // Settings: every tab
      const tabs = ["updates", "account", "language", "appearance", "notifications", "mate", "providers", "connections", "usage", "admin"];
      for (const tab of lang === "en" ? tabs : ["appearance", "updates", "usage"]) {
        await page.goto(`${SERVER}/?view=settings&tab=${tab}`);
        await page.waitForSelector(`[data-testid="settings-panel-${tab}"]`, { timeout: 15000 }).catch(() => {});
        await sleep(tab === "admin" || tab === "usage" ? 2500 : 900);
        await shot(page, `settings-${tab}-desktop-${T}`);
      }
      if (lang === "en") {
        // Admin's other parts (system monitor, logs)
        for (const name of ["System", "Logs", "Security"]) {
          const b = page.locator(`[data-testid="settings-panel-admin"] button:has-text("${name}")`).first();
          if (await b.count()) {
            await b.click().catch(() => {});
            await sleep(2500);
            await shot(page, `settings-admin-${name.toLowerCase()}-desktop-${T}`);
          }
        }
        await page.goto(`${SERVER}/?view=downloads`);
        await sleep(1500);
        await shot(page, `downloads-desktop-${T}`);
      }
      // Mate
      await page.goto(`${SERVER}/?view=mate&mate=${data.mate.id}`);
      await page.waitForSelector('[data-testid="mate-settings-open"]', { timeout: 20000 });
      await sleep(1800);
      await shot(page, `mate-desktop-${T}`);
      await page.goto(`${SERVER}/?view=mate&mate=${data.mate.id}&panel=relation`);
      await sleep(2000);
      await shot(page, `mate-relation-desktop-${T}`);
      if (lang === "en") {
        await page.goto(`${SERVER}/?view=mate&mate=${data.mate.id}`);
        await page.waitForSelector('[data-testid="mate-settings-open"]', { timeout: 20000 });
        await page.click('[data-testid="mate-settings-open"]');
        await sleep(900);
        for (const tab of ["profile", "style", "avatar", "voice", "memory", "relation"]) {
          const b = page.locator(`[data-testid="mate-tab-${tab}"]`);
          if (await b.count()) {
            await b.click();
            await sleep(800);
            await shot(page, `mate-settings-${tab}-desktop-${T}`);
          }
        }
      }
      await ctx.close();
      if (lang === "en") {
        step(`screens: ${T} (phone)`);
        const pc = await device(browser, { theme, lang, phone: true, colorScheme: theme });
        const p = await pc.newPage();
        await p.addInitScript((id) => localStorage.setItem("hrh_last_session", id), data.chat.id);
        await p.goto(`${SERVER}/?view=chat&session=${data.chat.id}`);
        await p.waitForSelector("textarea", { timeout: 20000 });
        await sleep(1500);
        await shot(p, `chat-phone-${T}`);
        const sheet = p.locator('button:has-text("Agent ·")').first();
        if (await sheet.count()) {
          await sheet.click().catch(() => {});
          await sleep(700);
          await shot(p, `chat-sheet-phone-${T}`);
          await p.keyboard.press("Escape").catch(() => {});
          await p.goto(`${SERVER}/?view=chat&session=${data.chat.id}`);
          await p.waitForSelector("textarea", { timeout: 20000 });
          await sleep(800);
        }
        const menu = p.locator('[data-testid="mobile-menu"], button[aria-label="Menu"], button[aria-label="Open menu"]').first();
        if (await menu.count()) {
          await menu.click().catch(() => {});
          await sleep(700);
          await shot(p, `sidebar-phone-${T}`);
        }
        await p.goto(`${SERVER}/?view=settings`);
        await sleep(1200);
        await shot(p, `settings-list-phone-${T}`);
        await p.goto(`${SERVER}/?view=settings&tab=appearance`);
        await sleep(1000);
        await shot(p, `settings-appearance-phone-${T}`);
        await p.goto(`${SERVER}/?view=mate&mate=${data.mate.id}`);
        await sleep(2200);
        await shot(p, `mate-phone-${T}`);
        await pc.close();
      }
    }
    // the pages around the app
    step(`screens: ${theme} login / boot / surfaces`);
    const anon = await device(browser, { theme, login: false, colorScheme: theme });
    const lp = await anon.newPage();
    await lp.goto(`${SERVER}/login`);
    await sleep(800);
    await shot(lp, `login-desktop-${theme}`);
    await anon.close();
    const anonPhone = await device(browser, { theme, login: false, colorScheme: theme, phone: true });
    const lpp = await anonPhone.newPage();
    await lpp.goto(`${SERVER}/login`);
    await sleep(800);
    await shot(lpp, `login-phone-${theme}`);
    await anonPhone.close();
    const bc = await device(browser, { theme, colorScheme: theme });
    const bp = await bc.newPage();
    // the boot screen: the app's code held back
    await bp.route(/\/assets\/index-.*\.js$/, async (route) => {
      await sleep(4000);
      await route.continue().catch(() => {});
    });
    bp.goto(SERVER + "/").catch(() => {});
    await sleep(1500);
    await shot(bp, `boot-desktop-${theme}`, { audit: false });
    await bp.unroute(/\/assets\/index-.*\.js$/);
    // the code cannot load at all: reload once, then "could not be loaded"
    await bp.route(/\/assets\/index-.*\.js$/, (route) => route.abort());
    await bp.goto(SERVER + "/").catch(() => {});
    await sleep(3500);
    await shot(bp, `boot-failed-desktop-${theme}`);
    await bp.unroute(/\/assets\/index-.*\.js$/);
    // the desktop Mate's quick card / avatar surfaces over a busy "wallpaper"
    for (const s of ["mate-quick", "mate-chat"]) {
      await bp.goto(`${SERVER}/?surface=${s}&mate=${data.mate.id}`);
      await sleep(2500);
      if (s === "mate-quick") await bp.addStyleTag({ content: "html.mate-transparent{background:linear-gradient(120deg,#ffcf6b,#1d4ed8 40%,#0f172a 70%,#e2e8f0) !important}" });
      await sleep(300);
      await shot(bp, `surface-${s}-${theme}`);
    }
    await bc.close();
  }
}

// ── checks ───────────────────────────────────────────────────────────────────────────────────────────────────────
async function checks(browser) {
  const ctx = await device(browser, { colorScheme: "dark" });
  await api(ctx, "PUT", "/api/preferences", { theme: null });
  const a = await ctx.newPage();
  await a.goto(`${SERVER}/?view=settings&tab=appearance`);
  await a.waitForSelector('[data-testid="settings-theme-light"]', { timeout: 20000 });
  const b = await ctx.newPage();
  await b.goto(`${SERVER}/?view=mate`);
  await b.waitForSelector("#root > *", { timeout: 20000 });
  await sleep(1200);

  step("System (nothing chosen) follows the OS: dark now");
  assert.equal((await htmlTheme(a)).theme, "dark");
  assert.equal((await htmlTheme(a)).mode, "system");

  step("pick Light: applied at once here and in the other window, saved to the account");
  const t0 = Date.now();
  await a.click('[data-testid="settings-theme-light"]');
  await until("light here", async () => (await htmlTheme(a)).theme === "light", 2000);
  await until("light in the other window", async () => (await htmlTheme(b)).theme === "light", 2000);
  console.log(`  other window followed in ${Date.now() - t0} ms`);
  assert.equal((await htmlTheme(b)).bg, "rgb(241, 243, 247)");
  await until("saved", async () => (await api(ctx, "GET", "/api/preferences")).theme === "light");
  assert.match(await a.textContent('[data-testid="settings-theme-msg"]'), /Saved/);
  assert.equal(await a.evaluate(() => document.querySelector('meta[name="theme-color"]').content), "#f1f3f7");
  await shot(a, "check-picked-light", { audit: false });

  step("reload: the theme is there before the app's code runs (no dark flash)");
  await a.route(/\/assets\/index-.*\.js$/, async (route) => {
    await sleep(2500);
    await route.continue().catch(() => {});
  });
  const reload = a.reload().catch(() => {});
  await a.waitForSelector("#hrh-boot", { timeout: 5000 });
  const first = await htmlTheme(a);
  assert.equal(first.cls, "light");
  assert.equal(await a.evaluate(() => getComputedStyle(document.documentElement).backgroundColor), "rgb(241, 243, 247)");
  assert.equal(await a.evaluate(() => !!window.__hrhBooted), false, "the app had not started yet");
  await shot(a, "check-first-frame-light", { audit: false });
  await reload;
  await a.unroute(/\/assets\/index-.*\.js$/);
  await a.waitForSelector('[data-testid="settings-theme-light"]', { timeout: 20000 });

  step("System follows prefers-color-scheme live");
  await a.click('[data-testid="settings-theme-system"]');
  await until("system → dark", async () => (await htmlTheme(a)).theme === "dark", 2000);
  await a.emulateMedia({ colorScheme: "light" });
  await until("OS light", async () => (await htmlTheme(a)).theme === "light", 2000);
  await a.emulateMedia({ colorScheme: "dark" });
  await until("OS dark", async () => (await htmlTheme(a)).theme === "dark", 2000);
  assert.match(await a.textContent('[data-testid="settings-theme-system"]'), /Dark now/);

  step("another device follows the account's choice; one that keeps its own does not");
  await a.click('[data-testid="settings-theme-dark"]');
  await until("saved dark", async () => (await api(ctx, "GET", "/api/preferences")).theme === "dark");
  await a.click('[data-testid="settings-theme-light"]');
  await until("saved light", async () => (await api(ctx, "GET", "/api/preferences")).theme === "light");
  const other = await device(browser, { colorScheme: "dark", theme: "dark" });
  const o = await other.newPage();
  await o.goto(SERVER + "/");
  await until("other device → light", async () => (await htmlTheme(o)).theme === "light", 10000);
  // that device: this device only, dark
  await o.goto(`${SERVER}/?view=settings&tab=appearance`);
  await o.waitForSelector('[data-testid="settings-theme-device"]', { timeout: 20000 });
  await o.click('[data-testid="settings-theme-device"]');
  await o.click('[data-testid="settings-theme-dark"]');
  await until("dark there", async () => (await htmlTheme(o)).theme === "dark");
  await sleep(500);
  assert.equal((await api(ctx, "GET", "/api/preferences")).theme, "light", "the account keeps light");
  await o.reload();
  await o.waitForSelector('[data-testid="settings-theme-device"]', { timeout: 20000 });
  await sleep(1500);
  assert.equal((await htmlTheme(o)).theme, "dark", "this device only: the account's light is not applied");
  await other.close();

  step("the login page: the cookie, else the system");
  const anon = await browser.newContext({ ...DESK, colorScheme: "light" });
  const lp = await anon.newPage();
  await lp.goto(`${SERVER}/login`);
  const bgOf = () => lp.evaluate(() => getComputedStyle(document.querySelector(".card")).backgroundColor);
  assert.match(await bgOf(), /255, 255, 255/);
  await anon.addCookies([{ name: "hrh_theme", value: "dark", url: SERVER }]);
  await lp.reload();
  assert.equal(await lp.evaluate(() => document.documentElement.className), "dark");
  assert.doesNotMatch(await bgOf(), /255, 255, 255/);
  await anon.close();

  await api(ctx, "PUT", "/api/preferences", { theme: null });
  await ctx.close();
}

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
  try {
    if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
    if (!ONLY || ONLY === "checks") await checks(browser);
    if (!ONLY || ONLY === "shots") {
      const data = await seed(browser);
      await shots(browser, data);
      const bad = report.filter((r) => r.bad.length && /-light/.test(r.name));
      console.log(`\ncontrast: ${report.length} screens audited, ${bad.length} light screen(s) with low-contrast text`);
      if (SHOTS) fs.writeFileSync(path.join(SHOTS, "contrast-report.json"), JSON.stringify(report, null, 1));
      if (process.env.HRH_STRICT_CONTRAST === "1" && bad.length) throw new Error("low-contrast text in light mode");
    }
    console.log("OK");
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
