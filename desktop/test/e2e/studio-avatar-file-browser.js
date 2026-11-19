// The Mate Create studio with an avatar the user brings as a file (docs/avatar-create.md §11 "An avatar the user brings"), in a
// browser against a throwaway server (fake-claude as the creation agent):
//
//   python3 desktop/test/e2e/session-rewind-server.py 18983 <frontend dist> <workspace> &
//   NODE_PATH=<dir with playwright-core> CHROME=<chromium binary> \
//     node desktop/test/e2e/studio-avatar-file-browser.js http://127.0.0.1:18983 rewind-test-only <shots dir>
//
// Checks: a new mate's studio → the Guide's 모습 step → 내 파일 쓰기 → the file window (a Live2D model in a zip) → she has it
// at once, her emotions matched to its expressions by name (nothing asked of the AI), the emotion window shows the matches
// and its Done finishes the step; the canvas turns to the file → emotions → mate.
"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright-core");

const [SERVER, PASSWORD, SHOTS] = process.argv.slice(2);
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

/** a zip (stored, no compression) of these files — a Live2D model as a user has one */
function zip(files) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const local = [], central = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const body = Buffer.from(data), n = Buffer.from(name), c = crc(body);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt32LE(c, 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(body.length, 22); h.writeUInt16LE(n.length, 26);
    local.push(h, n, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(c, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(body.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, n);
    offset += h.length + n.length + body.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true, args: ["--no-sandbox"] });
  const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
    await ctx.addInitScript(() => {
      localStorage.setItem("hrh_lang", "ko");
      localStorage.setItem("hrh_setup_seen_v2", "1");
    });
    assert.ok((await ctx.request.post(`${SERVER}/api/auth/login`, { data: { username: "admin", password: PASSWORD } })).ok());
    const model = {
      Version: 3,
      FileReferences: {
        Moc: "hiyori.moc3", Textures: [],
        Expressions: [{ Name: "F01_smile", File: "exp/f01.exp3.json" }, { Name: "F05_cry", File: "exp/f05.exp3.json" }],
        Motions: { Idle: [{ File: "m/idle.motion3.json" }], TapBody: [{ File: "m/tap.motion3.json" }] },
      },
    };
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "studio-file-")), "hiyori.zip");
    fs.writeFileSync(file, zip({ "hiyori/hiyori.model3.json": JSON.stringify(model), "hiyori/hiyori.moc3": "MOC3", "hiyori/exp/f01.exp3.json": "{}",
      "hiyori/exp/f05.exp3.json": "{}", "hiyori/m/idle.motion3.json": "{}", "hiyori/m/tap.motion3.json": "{}" }));

    step("a new mate's studio; the Guide's look step offers a file of one's own");
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(`${SERVER}/?view=mate&create=new`);
    await p.waitForSelector('[data-testid="studio-guide"][data-mode="create"]', { timeout: 60000 });
    await until("the draft in the URL", () => /create=mate_/.test(p.url()));
    const mid = new URL(p.url()).searchParams.get("create");
    const state = (id) => p.locator(`[data-testid="guide-step-${id}"]`).getAttribute("data-state");
    assert.notEqual(await state("look"), "done");
    await p.click('[data-testid="guide-step-look-toggle"]');
    await p.click('[data-testid="look-file"]');
    await p.click('[data-testid="guide-file-open"]');
    await p.waitForSelector('[data-testid="look-import"]');
    await p.screenshot({ path: path.join(SHOTS, "01-studio-file-window.png") });

    step("a Live2D model: she has it at once, her emotions matched by name");
    const uploaded = p.waitForResponse((r) => r.url().includes(`/api/mates/${mid}/avatar/import`) && r.request().method() === "POST");
    await p.setInputFiles('[data-testid="look-file-input"]', file);
    assert.equal((await uploaded).status(), 200);
    await p.waitForSelector('[data-testid="look-import"][data-kind="live2d"]', { timeout: 30000 });
    await until("matched by name", async () => {
      const m = await (await ctx.request.get(`${SERVER}/api/mates/${mid}`)).json();
      return m.avatar.kind === "live2d" && m.avatar.live2d.emotions?.smile === "F01_smile" && m.avatar.live2d.emotions?.sad === "F05_cry";
    }, 20000);
    assert.match(await p.locator('[data-testid="look-import-done"]').innerText(), /2개/);
    await p.screenshot({ path: path.join(SHOTS, "02-studio-file-imported.png") });

    step("the emotion window: the matches; its Done finishes the look step");
    await p.click('[data-testid="look-import-next"]');
    await p.waitForSelector('[data-testid="look-mapper"]');
    assert.equal(await p.locator('[data-testid="look-map-smile-face"]').inputValue(), "F01_smile");
    assert.equal(await p.locator('[data-testid="look-map-sad-face"]').inputValue(), "F05_cry");
    await p.screenshot({ path: path.join(SHOTS, "03-studio-emotions.png") });
    await p.click('[data-testid="look-mapper-done"]');
    await until("the look step done", async () => (await state("look")) === "done");

    step("the canvas: the file and her emotions, nothing drawn");
    await p.waitForSelector('[data-testid="sc-node-import"]');
    await p.waitForSelector('[data-testid="sc-node-motions"]');
    assert.equal(await p.locator('[data-testid="sc-node-estimate"]').count(), 0);
    await p.screenshot({ path: path.join(SHOTS, "04-studio-file-canvas.png") });

    assert.deepEqual(errors, [], "no page errors");
    console.log("OK");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
