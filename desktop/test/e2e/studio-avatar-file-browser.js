// The Mate Create studio with an avatar the user brings as a file (docs/avatar-create.md §11 "An avatar the user brings"), in a
// browser against a throwaway server (fake-claude as the creation agent):
//
//   python3 desktop/test/e2e/session-rewind-server.py 18983 <frontend dist> <workspace> &
//   NODE_PATH=<dir with playwright-core> CHROME=<chromium binary> \
//     node desktop/test/e2e/studio-avatar-file-browser.js http://127.0.0.1:18983 rewind-test-only <shots dir>
//
// Checks: a new mate's studio → Avatar → Bring a file (a Live2D model in a zip) → she has it at once, the Look and Avatar
// steps are done, the agent hears of it (a divider, and it answers); the mapping of her emotions shows in the section.
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

    step("a new mate's studio; the Avatar section offers a file of one's own");
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(`${SERVER}/?view=mate&create=new`);
    await p.waitForSelector('[data-testid="studio-steps"]', { timeout: 60000 });
    await until("the draft in the URL", () => /create=mate_/.test(p.url()));
    const mid = new URL(p.url()).searchParams.get("create");
    const state = (id) => p.locator(`[data-testid="studio-steps"] [data-step="${id}"]`).getAttribute("data-state");
    assert.notEqual(await state("avatar"), "done");
    const openAvatar = async () => {
      if ((await p.locator('[data-testid="studio-section-avatar"]').getAttribute("data-open")) !== "1") await p.locator('[data-testid="studio-section-toggle-avatar"]').click();
    };
    await openAvatar();
    await p.locator('[data-testid="studio-avatar-bring"]').waitFor();
    await p.screenshot({ path: path.join(SHOTS, "01-studio-avatar-section.png") });

    step("Bring a file: a Live2D model — she has it at once, the Look and Avatar steps are done");
    const uploaded = p.waitForResponse((r) => r.url().includes(`/api/mates/${mid}/avatar/import`) && r.request().method() === "POST");
    const told = p.waitForResponse((r) => r.url().includes("/brought-avatar"));
    await p.setInputFiles('[data-testid="studio-avatar-file"]', file);
    assert.equal((await uploaded).status(), 200);
    assert.equal((await told).status(), 200);
    const mate = await (await ctx.request.get(`${SERVER}/api/mates/${mid}`)).json();
    assert.equal(mate.avatar.kind, "live2d");
    await until("the Avatar step done", async () => (await state("avatar")) === "done");
    assert.equal(await state("look"), "done");
    assert.match(await p.locator('[data-testid="studio-emotion-map"]').innerText(), /연결된 표정이 아직 없어요/);

    step("the agent hears of it: a divider, then its answer");
    await until("the divider", async () => (await p.locator('[data-testid="avatar-event"]').allInnerTexts()).some((x) => x.includes("아바타 파일을 넣었어요")), 30000);
    await sleep(4000);
    await p.screenshot({ path: path.join(SHOTS, "02-studio-avatar-brought.png") });

    step("her emotions mapped (as the agent's map_avatar_emotions leaves it): the section shows them");
    const now = await (await ctx.request.get(`${SERVER}/api/mates/${mid}`)).json();
    const r = await ctx.request.patch(`${SERVER}/api/mates/${mid}`, { data: { avatar: { ...now.avatar, live2d: { ...now.avatar.live2d, emotions: { joy: "F01_smile", sad: "F05_cry" } } } } });
    assert.ok(r.ok(), `patch ${r.status()}`);
    await p.reload();
    await p.waitForSelector('[data-testid="studio-steps"]', { timeout: 60000 });
    await openAvatar();
    await until("the mapping shown", async () => /joy → F01_smile/.test(await p.locator('[data-testid="studio-emotion-map"]').innerText()), 20000);
    await p.screenshot({ path: path.join(SHOTS, "03-studio-emotion-map.png") });

    assert.deepEqual(errors, [], "no page errors");
    console.log("OK");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
