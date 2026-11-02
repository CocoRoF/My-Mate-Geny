// The desktop app's words (src/i18n.js): Korean has every English key with the same {placeholders}, every key the
// code asks for exists, and every connect-core failure kind has a headline.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { MESSAGES, pickLanguage, translator, pageText } = require("../src/i18n");

const flat = (o, pre = "") =>
  Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? flat(v, `${pre}${k}.`) : [[`${pre}${k}`, v]]));
const holes = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

test("ko has exactly en's keys, non-empty, with the same placeholders", () => {
  const en = new Map(flat(MESSAGES.en));
  const ko = new Map(flat(MESSAGES.ko));
  assert.deepEqual([...ko.keys()].sort(), [...en.keys()].sort());
  for (const [k, v] of en) {
    assert.ok(String(ko.get(k)).trim(), `ko ${k} is empty`);
    assert.equal(holes(ko.get(k)), holes(v), `${k}: placeholders differ`);
  }
});

test("every key the app uses exists", () => {
  const src = ["main.js", "mate.js"].map((f) => fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8")).join("\n");
  const used = [...src.matchAll(/\bt\("([\w.]+)"/g)].map((m) => m[1]);
  assert.ok(used.length > 30);
  const en = new Map(flat(MESSAGES.en));
  for (const k of used) assert.ok(en.has(k), `missing message ${k}`);
  // the local pages read hrhNative.text: say("key", …)
  for (const f of ["offline.html", "connect.html", "capture-ask.html"]) {
    const html = fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8");
    for (const m of html.matchAll(/say\("(\w+)"\s*[,)]/g)) assert.ok(en.has(`page.${m[1]}`), `${f}: missing page.${m[1]}`);
  }
});

test("every connect-core failure kind has a headline", () => {
  const core = fs.readFileSync(path.join(__dirname, "..", "src", "connect-core.js"), "utf8");
  const block = core.slice(core.indexOf("var MESSAGES = {"), core.indexOf("};", core.indexOf("var MESSAGES = {")));
  const kinds = [...block.matchAll(/^\s+(\w+):/gm)].map((m) => m[1]);
  assert.ok(kinds.length >= 10);
  for (const k of kinds) assert.ok(MESSAGES.en.page[`err_${k}`] && MESSAGES.ko.page[`err_${k}`], `no headline for ${k}`);
});

test("the language: a stored choice, else the system's", () => {
  assert.equal(pickLanguage("ko", "en-US"), "ko");
  assert.equal(pickLanguage("en", "ko-KR"), "en");
  assert.equal(pickLanguage(undefined, "ko-KR"), "ko");
  assert.equal(pickLanguage("fr", "ko"), "ko");
  assert.equal(pickLanguage(null, "de-DE"), "en");
  const t = translator("ko");
  assert.equal(t("trayQuit"), "종료");
  assert.equal(t("hotkeyBody", { key: "Ctrl + G" }).startsWith("Ctrl + G"), true);
  assert.equal(translator("xx")("trayQuit"), "Quit");
  assert.equal(pageText("ko").retryingIn, "{n}초 뒤에 다시 시도해요");
  assert.equal(pageText("en").connectTitle, "Connect — My Mate Geny");
});
