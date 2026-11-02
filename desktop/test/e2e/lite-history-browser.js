// Lite chat history (backend services/history_lite.py) in a real browser against a real server with a big chat: the
// newest page comes lite (?lite=1, previews + event.lazy); opening a tool row fetches the original and shows it whole
// (copying the output gives the full text), an Edit's diff and a subagent's prompt likewise; scrolling up loads every
// older page; a row of an older page opens too. MODE=old: the same frontend against a backend without lite — full
// pages, nothing fetched, the same rows open. MATE=1 also checks a mate conversation (history + a live reply; the
// backend runs CLAUDE_BINARY=desktop/test/e2e/fake-claude.py). Screenshots go to SHOTS
// (default ~/.cache/hrh-lite-history-shots).
//
//   NODE_PATH=<dir with playwright-core> CHROME=<chromium binary> HRH_TOKEN=<session token> \
//     node test/e2e/lite-history-browser.js <server url> <session id>
"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright-core");

const [SERVER, SID] = process.argv.slice(2);
const TOKEN = process.env.HRH_TOKEN;
if (!SERVER || !SID || !TOKEN) {
  console.error("usage: HRH_TOKEN=… node test/e2e/lite-history-browser.js <server url> <session id>");
  process.exit(2);
}
const MODE = process.env.MODE || "new";
const SHOTS = process.env.SHOTS || path.join(os.homedir(), ".cache", "hrh-lite-history-shots");
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`• ${s}`);
async function until(what, fn, ms = 20000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}
const shot = (p, name) => p.screenshot({ path: path.join(SHOTS, `${MODE}-${name}`) });
const clip = (s, n = 20000) => (s.length > n ? s.slice(0, n) : s); // (ToolDetail shows the first 20000 chars)

/** Calls of a page: id -> {use, result} events (top-level ones: rows in the chat itself). */
function calls(page) {
  const by = new Map();
  for (const e of page.events) {
    if (e.type !== "tool.use" && e.type !== "tool.result") continue;
    const id = String(e.data.id || "");
    const c = by.get(id) || {};
    c[e.type === "tool.use" ? "use" : "result"] = e;
    by.set(id, c);
  }
  return [...by.entries()].filter(([, c]) => c.use && c.result && !c.use.data.parent);
}

async function original(ctx, eid) {
  const r = await ctx.request.get(`${SERVER}/api/history/${SID}/events/${eid}`);
  assert.ok(r.ok(), `event ${eid}`);
  return r.json();
}

/** Open the groups (newest first) until the row of call `id` shows; returns its locator. */
async function revealRow(p, id) {
  const row = p.locator(`[data-tool-id="${id}"]`).first();
  if (await row.count()) return row;
  const groups = p.locator('[data-testid="tool-group"]');
  const n = await groups.count();
  for (let i = n - 1; i >= 0; i--) {
    const g = groups.nth(i);
    await g.scrollIntoViewIfNeeded();
    await g.click();
    await sleep(60);
    if (await row.count()) return row;
    await g.click(); // (not this one: fold it again)
  }
  throw new Error(`no row for ${id}`);
}

async function main() {
  if (process.env.MATE === "only") return mate().then(() => console.log("OK"));
  const browser = await chromium.launch({ executablePath: process.env.CHROME });
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
    deviceScaleFactor: 1,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  await ctx.addCookies([{ name: "hrh_session", value: TOKEN, url: SERVER }]);
  await ctx.addInitScript(() => localStorage.setItem("hrh_lang", "en"));
  const p = await ctx.newPage();
  const requests = [];
  p.on("request", (r) => {
    if (r.url().includes("/api/history/")) requests.push({ url: r.url(), method: r.method() });
  });
  const pages = [];
  p.on("response", async (r) => {
    const u = new URL(r.url());
    if (u.pathname === `/api/history/${SID}` && r.ok()) pages.push({ url: r.url(), json: await r.json(), bytes: (await r.body()).length });
  });
  const fetches = () => requests.filter((r) => r.method === "POST" && r.url.endsWith("/events")).length;

  try {
    step(`open the chat (${MODE} backend)`);
    const t0 = Date.now();
    await p.goto(`${SERVER}/?view=chat&session=${SID}`);
    await p.waitForSelector('[data-testid="tool-group"]', { timeout: 30000 });
    const shown = Date.now() - t0;
    const newest = await until("the newest page", () => pages[0]);
    assert.ok(newest.url.includes("lite=1"), "the new frontend asks for lite pages");
    const lazyEvents = newest.json.events.filter((e) => e.lazy).length;
    if (MODE === "new") assert.ok(lazyEvents > 0, "lite page: previews");
    else assert.equal(lazyEvents, 0, "a backend without lite: full page");
    console.log(`  newest page: ${(newest.bytes / 1e6).toFixed(3)} MB, ${newest.json.events.length} events, ${lazyEvents} previews; first tool rows after ${shown} ms`);
    await sleep(800);
    await shot(p, "01-newest.png");

    step("a Bash row with a big output: opens whole; copying it gives the full text");
    const bash = calls(newest.json).filter(([, c]) => {
      const n = String(c.use.data.name).replace(/^mcp__remote__/, "").toLowerCase();
      const size = c.result.lazy ? c.result.lazy.output.size : String(c.result.data.output || "").length;
      return ["bash", "remote_bash"].includes(n) && !c.result.data.is_error && size > 1500 && size < 20000;
    });
    assert.ok(bash.length, "a big Bash output in the newest page");
    const [bid, bc] = bash[bash.length - 1];
    const fullOut = String((MODE === "new" ? (await original(ctx, bc.result.eid)).data : bc.result.data).output);
    if (MODE === "new") assert.ok(bc.result.lazy && String(bc.result.data.output).length < fullOut.length, "sent as a preview");
    const before = fetches();
    const row = await revealRow(p, bid);
    await row.locator('[data-testid="tool-row"]').first().click({ position: { x: 14, y: 12 } }); // (on the icon: the path in the middle opens the file)
    const out = row.locator("pre").nth(1);
    await until("the full output", async () => (await out.count()) && (await out.innerText()).length >= Math.min(fullOut.length, 20000) - 5);
    assert.equal((await out.innerText()).trimEnd(), clip(fullOut).trimEnd(), "the whole output shows");
    if (MODE === "new") assert.ok(fetches() > before, "fetched on open");
    else assert.equal(fetches(), 0, "nothing to fetch from an old backend");
    await out.evaluate((el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    });
    await p.keyboard.press("Control+C");
    const copied = await p.evaluate(() => navigator.clipboard.readText());
    assert.equal(copied.trimEnd(), clip(fullOut).trimEnd(), "copy: the full output");
    console.log(`  output ${fullOut.length} chars (preview ${String(bc.result.data.output).length}), copied ${copied.length}`);
    await row.scrollIntoViewIfNeeded();
    await shot(p, "02-bash-expanded.png");

    step("scroll up through every older page");
    const scroller = p.locator('[data-testid="message-scroll"]');
    for (let k = 0; k < 40; k++) {
      const last = pages[pages.length - 1];
      if (pages.length > 1 && !last.json.page.has_more) break;
      const n = pages.length;
      await scroller.evaluate((el) => (el.scrollTop = 0));
      await until(`older page ${n}`, () => pages.length > n, 30000).catch(() => null);
      await sleep(250);
    }
    const older = pages.slice(1).filter((x) => x.url.includes("before="));
    assert.ok(older.length >= 1, "older pages loaded");
    assert.ok(!pages[pages.length - 1].json.page.has_more, "reached the beginning");
    for (const o of older) assert.ok(o.url.includes("lite=1"));
    console.log(`  ${older.length} older pages: ${older.map((o) => (o.bytes / 1e6).toFixed(2) + " MB").join(", ")}`);
    await sleep(500);
    await shot(p, "03-scrolled-to-top.png");

    step("an Edit's diff (from an older page): the diff is the original's");
    const all = pages.flatMap((x) => calls(x.json));
    const edits = all.filter(([, c]) => {
      const n = String(c.use.data.name).replace(/^mcp__remote__/, "").toLowerCase();
      return n === "edit" && !c.result.data.is_error && (MODE === "old" || c.use.lazy);
    });
    assert.ok(edits.length, "an Edit call");
    const [eid_, ec] = edits[Math.floor(edits.length / 2)];
    const inp = MODE === "new" ? (await original(ctx, ec.use.eid)).data.input : ec.use.data.input;
    const erow = await revealRow(p, eid_);
    await erow.locator('[data-testid="tool-row"]').first().click({ position: { x: 14, y: 12 } }); // (on the icon: the path in the middle opens the file)
    // a line the edit added (changed lines always show; unchanged runs fold)
    const oldLines = new Set(String(inp.old_string || "").split("\n"));
    const want = String(inp.new_string || "").split("\n").find((l) => !oldLines.has(l) && l.trim().length > 3)?.trim() || "";
    await until("the diff", async () => (await erow.innerText()).includes(want)).catch(async (e) => {
      await erow.scrollIntoViewIfNeeded().catch(() => {});
      await shot(p, "04-edit-diff-FAILED.png");
      console.log(`  want ${JSON.stringify(want)}\n  row: ${(await erow.innerText()).slice(0, 600)}`);
      throw e;
    });
    console.log(`  edit of ${inp.file_path}: ${String(inp.old_string || "").length} → ${String(inp.new_string || "").length} chars; shows "${want.slice(0, 50)}"`);
    await erow.scrollIntoViewIfNeeded();
    await shot(p, "04-edit-diff.png");

    step("a subagent: the modal shows its full prompt");
    const agents = all.filter(([, c]) => ["agent", "task"].includes(String(c.use.data.name).toLowerCase()) && (MODE === "old" || c.use.lazy));
    if (agents.length) {
      const [aid, ac] = agents[agents.length - 1];
      const prompt = String((MODE === "new" ? (await original(ctx, ac.use.eid)).data.input : ac.use.data.input).prompt || "");
      const card = p.locator(`[data-agent-id="${aid}"]`).first();
      await card.scrollIntoViewIfNeeded();
      await card.click();
      const pre = p.locator("details pre").first();
      await until("the prompt", async () => (await pre.count()) && (await pre.textContent()).length >= prompt.length);
      assert.equal(await pre.textContent(), prompt, "the whole prompt");
      console.log(`  prompt ${prompt.length} chars (preview ${String(ac.use.data.input.prompt || "").length})`);
      await shot(p, "05-subagent-modal.png");
      await p.keyboard.press("Escape");
      await sleep(300);
    } else console.log("  (no subagent with a long prompt in this chat)");
    console.log(`  ${fetches()} fetches of originals in all`);
  } finally {
    await browser.close();
  }

  if (process.env.MATE === "1" || process.env.MATE === "only") await mate();
  console.log("OK");
}

async function mate() {
  step("a mate conversation: history and a live reply (full pages, as before)");
  const browser = await chromium.launch({ executablePath: process.env.CHROME });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies([{ name: "hrh_session", value: TOKEN, url: SERVER }]);
  const m = await (await ctx.request.post(`${SERVER}/api/mates`, { data: { name: `Lite ${Date.now() % 10000}` } })).json();
  await ctx.addInitScript((id) => {
    localStorage.setItem("hrh_lang", "en");
    localStorage.setItem("hrh_mate_active", id);
  }, m.id);
  const urls = [];
  try {
    const p = await ctx.newPage();
    p.on("request", (r) => r.url().includes("/api/history/") && urls.push(r.url()));
    await p.goto(`${SERVER}/?view=mate`);
    const input = p.locator('[data-testid="mate-input"]').first();
    await input.waitFor({ timeout: 30000 });
    await sleep(1500);
    await input.fill("hello there");
    await input.press("Enter");
    const bubbles = p.locator('[data-testid="mate-bubble"]');
    const text = async () => (await p.locator("body").innerText());
    await until("the reply, streamed live", async () => (await text()).includes("Reply 1 sentence number 5"), 40000).catch(async (e) => {
      await shot(p, "06-mate-FAILED.png");
      console.log(`  bubbles: ${JSON.stringify(await bubbles.allInnerTexts())}\n  page: ${(await p.locator("body").innerText()).slice(0, 800)}`);
      throw e;
    });
    await sleep(500);
    const live = await bubbles.count();
    await shot(p, "06-mate-live.png");
    await p.reload();
    await until("history after reload", async () => (await text()).includes("Reply 1 sentence number 5") && (await text()).includes("hello there"), 30000);
    await sleep(1000);
    await shot(p, "07-mate-history.png");
    assert.ok(urls.length && urls.every((u) => !u.includes("lite=1")), "the mate keeps full pages");
    console.log(`  ${live} bubbles live, ${await p.locator('[data-testid="mate-bubble"]').count()} after reload`);
  } finally {
    await ctx.request.delete(`${SERVER}/api/mates/${m.id}`).catch(() => {});
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
