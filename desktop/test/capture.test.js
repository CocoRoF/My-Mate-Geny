// Screen capture for the Mate (src/capture.js, docs/mate.md §4 "Seeing the screen"): the size a picture gets, which
// source is captured (and when a remembered one is gone), the mate's request (ask → allow / deny / no answer, the
// avatar windows hidden and shown again, allowed without asking), the user's own grab, and the preload bridge.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { fitWithin, displayPixels, resolveSource, cleanOptions, createCapture, kindOf } = require("../src/capture");

test("fitWithin: the long side at most maxEdge, never upscaled, 0 = as it is", () => {
  assert.deepEqual(fitWithin(3840, 2160, 1920), { width: 1920, height: 1080 });
  assert.deepEqual(fitWithin(1080, 2400, 1280), { width: 576, height: 1280 });
  assert.deepEqual(fitWithin(800, 600, 1920), { width: 800, height: 600 });
  assert.deepEqual(fitWithin(5120, 2880, 0), { width: 5120, height: 2880 });
  assert.deepEqual(fitWithin(0, -3, 100), { width: 1, height: 1 });
  assert.deepEqual(displayPixels({ size: { width: 1440, height: 900 }, scaleFactor: 2 }), { width: 2880, height: 1800 });
  assert.deepEqual(displayPixels({ size: { width: 1920, height: 1080 } }), { width: 1920, height: 1080 });
});

test("cleanOptions: sizes and formats from the page are checked", () => {
  assert.deepEqual(cleanOptions({ max_edge: 2560, format: "jpeg", quality: 12, hide_avatar: false }), { maxEdge: 2560, format: "jpeg", quality: 40, hideAvatar: false });
  assert.deepEqual(cleanOptions({ maxEdge: 99999, format: "gif" }), { maxEdge: 1920, format: "png", quality: 85, hideAvatar: true });
  assert.equal(cleanOptions({ maxEdge: 0 }).maxEdge, 0);
});

const SOURCES = [
  { id: "screen:1:0", name: "Screen 2", display_id: "22" },
  { id: "screen:0:0", name: "Screen 1", display_id: "11" },
  { id: "window:77:0", name: "Terminal — build" },
  { id: "window:88:0", name: "Editor" },
  { id: "window:89:0", name: "Editor" },
];

test("resolveSource: the primary screen by default; a remembered source found again, or an explicit fallback", () => {
  assert.equal(kindOf("screen:0:0"), "screen");
  assert.equal(kindOf("window:1:0"), "window");
  assert.equal(resolveSource(SOURCES, null, "11").source.id, "screen:0:0");
  assert.equal(resolveSource(SOURCES, null, "999").source.id, "screen:1:0"); // (no display id match: the first screen)
  assert.deepEqual(resolveSource(SOURCES, { id: "window:77:0", kind: "window" }, "11"), { source: SOURCES[2], fallback: false, missing: null });
  // a screen whose id changed: the same display
  assert.equal(resolveSource(SOURCES, { id: "screen:9:0", kind: "screen", display_id: "22" }, "11").source.id, "screen:1:0");
  // a window whose id changed (its app restarted): the one window with that title
  assert.equal(resolveSource(SOURCES, { id: "window:5:0", kind: "window", name: "Terminal — build" }, "11").source.id, "window:77:0");
  // gone (or ambiguous): the primary screen, marked as a fallback with what is missing
  const pref = { id: "window:5:0", kind: "window", name: "Editor" };
  assert.deepEqual(resolveSource(SOURCES, pref, "11"), { source: SOURCES[1], fallback: true, missing: pref });
  assert.deepEqual(resolveSource([], null, "11"), { source: null, fallback: false, missing: null });
});

function image(w, h, { empty = false } = {}) {
  return {
    w, h,
    isEmpty: () => empty,
    getSize: () => ({ width: w, height: h }),
    resize: ({ width, height }) => image(width, height),
    toPNG: () => Buffer.from(`PNG ${w}x${h}`),
    toJPEG: (q) => Buffer.from(`JPEG ${w}x${h} q${q}`),
    toDataURL: () => `data:image/png;base64,${w}x${h}`,
  };
}

function rig(over = {}) {
  const log = [];
  let settings = {};
  const deps = {
    platform: "linux",
    env: {},
    delay: async () => {},
    desktopCapturer: {
      getSources: async ({ types, thumbnailSize }) => {
        log.push(["getSources", types.join(","), `${thumbnailSize.width}x${thumbnailSize.height}`]);
        if (over.noSources) return [];
        return SOURCES.filter((s) => types.includes(kindOf(s.id))).map((s) => ({
          ...s,
          // Electron fits the thumbnail inside thumbnailSize keeping the aspect (16:9 screens, 4:3 windows here)
          thumbnail: over.emptyShot && thumbnailSize.width > 400
            ? image(0, 0, { empty: true })
            : kindOf(s.id) === "screen"
              ? image(thumbnailSize.width, Math.round((thumbnailSize.width * 9) / 16))
              : image(Math.round((thumbnailSize.height * 4) / 3), thumbnailSize.height),
        }));
      },
    },
    screen: {
      getPrimaryDisplay: () => ({ id: 11, size: { width: 2560, height: 1440 }, scaleFactor: 1.5 }),
      getAllDisplays: () => [{ id: 11, size: { width: 2560, height: 1440 }, scaleFactor: 1.5 }, { id: 22, size: { width: 1920, height: 1080 }, scaleFactor: 1 }],
    },
    systemPreferences: { getMediaAccessStatus: () => over.permission || "granted" },
    readSettings: () => settings,
    writeSettings: (p) => (settings = { ...settings, ...p }),
    hideWindows: async () => {
      log.push(["hide"]);
      return () => log.push(["show"]);
    },
    ask: async (info) => {
      log.push(["ask", info.mateName, info.source && info.source.id, !!info.preview, info.missing ? info.missing.name : null]);
      return over.answer || "allow";
    },
    indicate: (state, info) => log.push(["indicate", state, info.mateName]),
    ...over.deps,
  };
  return { cap: createCapture(deps), log, settings: () => settings };
}

const REQ = { id: "cap_1", mate_id: "mate_a", mate_name: "Estelle", ask: true, hide_avatar: true, max_edge: 1920, format: "png", quality: 85, timeout_ms: 45000 };

test("request: asked and allowed → the avatar windows hide, the primary screen is captured at most 1920 px, shown again", async () => {
  const { cap, log } = rig();
  const r = await cap.request(REQ);
  assert.equal(r.ok, true);
  assert.equal(r.mime, "image/png");
  assert.deepEqual([r.width, r.height], [1920, 1080]); // 3840×2160 device pixels → 1920
  assert.equal(String(r.data), "PNG 1920x1080");
  assert.deepEqual(r.source, { id: "screen:0:0", name: "Screen 1", kind: "screen", display_id: "11" });
  const steps = log.map((x) => x[0]);
  assert.deepEqual(steps, ["getSources", "getSources", "ask", "indicate", "hide", "getSources", "show", "indicate"]);
  assert.deepEqual(log.find((x) => x[0] === "ask"), ["ask", "Estelle", "screen:0:0", true, null]);
  assert.deepEqual(log[5], ["getSources", "screen", "1920x1080"]); // only screens, at the capture size
  assert.deepEqual(log.at(-1), ["indicate", "done", "Estelle"]);
});

test("request: denied / no answer → nothing is captured; not hidden when that option is off", async () => {
  for (const [answer, code] of [["deny", "denied"], ["timeout", "timeout"], ["stopped", "stopped"]]) {
    const { cap, log } = rig({ answer });
    assert.deepEqual(await cap.request(REQ), { ok: false, code, message: "" });
    assert.ok(!log.some((x) => x[0] === "hide" || x[0] === "indicate"));
    assert.equal(log.filter((x) => x[0] === "getSources").length, 2); // the list + the small preview, never a picture
  }
  const { cap, log } = rig();
  const r = await cap.request({ ...REQ, hide_avatar: false, format: "jpeg", quality: 70, max_edge: 0 });
  assert.equal(String(r.data), "JPEG 3840x2160 q70");
  assert.ok(!log.some((x) => x[0] === "hide"));
});

test("request: a chosen window; gone → asked: the prompt says so; allowed without asking: nothing", async () => {
  const { cap, log, settings } = rig();
  assert.equal(cap.setChoice("mate_a", { id: "window:77:0", name: "Terminal — build" }), true);
  assert.equal(settings().captureSources.mate_a.kind, "window");
  const r = await cap.request(REQ);
  assert.equal(r.source.id, "window:77:0");
  assert.equal(r.source.kind, "window");
  cap.setChoice("mate_a", { id: "window:5:0", name: "Closed app" });
  const asked = await cap.request(REQ);
  assert.equal(asked.ok, true);
  assert.equal(asked.source.id, "screen:0:0");
  assert.equal(log.filter((x) => x[0] === "ask").at(-1)[4], "Closed app"); // the prompt names the missing window
  const silent = await cap.request({ ...REQ, ask: false });
  assert.deepEqual(silent, { ok: false, code: "source_gone", message: "" });
  cap.setChoice("mate_a", null);
  assert.equal(cap.getChoice("mate_a"), null);
  assert.equal(cap.setChoice("../x", { id: "screen:0:0" }), false);
});

test("request: allowed without asking → no prompt; empty / no permission / busy are said so", async () => {
  const quiet = rig();
  const r = await quiet.cap.request({ ...REQ, ask: false });
  assert.equal(r.ok, true);
  assert.ok(!quiet.log.some((x) => x[0] === "ask"));
  assert.equal((await rig({ emptyShot: true }).cap.request(REQ)).code, "empty");
  assert.equal((await rig({ noSources: true }).cap.request(REQ)).code, "empty");
  assert.equal((await rig({ deps: { platform: "darwin" }, permission: "denied" }).cap.request(REQ)).code, "permission");
  assert.equal((await rig({ deps: { platform: "darwin" }, noSources: true }).cap.request(REQ)).code, "permission");
  // one at a time: a second request while the first waits for its answer
  let release;
  const slow = rig({ deps: { ask: () => new Promise((res) => (release = res)) } });
  const first = slow.cap.request(REQ);
  await new Promise((r) => setImmediate(r));
  assert.equal((await slow.cap.request({ ...REQ, id: "cap_2" })).code, "busy");
  slow.cap.cancel("cap_1"); // the server gave up: even an Allow now captures nothing
  release("allow");
  assert.equal((await first).code, "stopped");
  assert.equal((await slow.cap.request({ ...REQ, id: "" })).code, "error");
});

test("grab (Share screen) and the picker's sources", async () => {
  const { cap, log } = rig({ deps: { ownSourceIds: () => ["window:88:0"] } });
  const r = await cap.grab({ sourceId: "window:77:0", maxEdge: 1280, hideAvatar: true });
  assert.equal(r.ok, true);
  assert.equal(r.source.id, "window:77:0");
  assert.ok(Math.max(r.width, r.height) <= 1280);
  assert.ok(log.some((x) => x[0] === "hide"));
  assert.equal((await cap.grab({ sourceId: "window:404:0" })).code, "source_gone");
  const list = await cap.sources({ thumbnails: true, size: 320 });
  assert.deepEqual(list.map((s) => s.id), ["screen:1:0", "screen:0:0", "window:77:0", "window:89:0"]); // (not our own windows)
  assert.equal(list.find((s) => s.id === "screen:0:0").primary, true);
  assert.ok(list.every((s) => s.thumbnail.startsWith("data:image/png")));
  assert.deepEqual(cap.info(), { version: 1, platform: "linux", wayland: false, permission: "granted" });
  assert.equal(rig({ deps: { env: { XDG_SESSION_TYPE: "wayland" } } }).cap.info().wayland, true);
});

// ── the preload bridge (src/preload.js): what a page can call, and with what ──

function loadPreload(surface) {
  const exposed = {};
  const calls = [];
  const electron = {
    contextBridge: { exposeInMainWorld: (k, v) => (exposed[k] = v) },
    ipcRenderer: {
      invoke: (ch, ...a) => (calls.push([ch, ...a]), Promise.resolve(null)),
      send: (ch, ...a) => calls.push([ch, ...a]),
      sendSync: () => null,
      on: () => {},
      removeListener: () => {},
    },
  };
  const code = fs.readFileSync(path.join(__dirname, "..", "src", "preload.js"), "utf8");
  vm.runInNewContext(code, {
    require: (m) => (m === "electron" ? electron : require(m)),
    process: { argv: [`--hrh-surface=${surface}`, "--hrh-version=0.4.99"], platform: "linux" },
    location: { protocol: "https:", pathname: "/" },
    console,
  });
  // (plain data from the other realm, so deepStrictEqual compares values, not prototypes)
  return { exposed, calls, plain: () => JSON.parse(JSON.stringify(calls)) };
}

test("preload: hrhNative.capture sends only clean arguments; hrhCaptureAsk exists only in the prompt window", async () => {
  const { exposed, plain } = loadPreload("mate-chat");
  const cap = exposed.hrhNative.capture;
  assert.equal(cap.version, 1);
  await cap.sources({ thumbnails: 1, size: "320" });
  await cap.grab({ sourceId: 5, maxEdge: "1280", format: "bmp", hideAvatar: false, extra: "x" });
  await cap.setChoice("mate_a", { id: "window:1:0", name: "A", kind: "window", evil: () => 1 });
  await cap.request({ id: "cap_1", ask: true, nested: { a: 1 } });
  await cap.cancel(7);
  const calls = plain();
  assert.deepEqual(calls[0], ["capture:sources", { thumbnails: true, size: 320 }]);
  assert.deepEqual(calls[1], ["capture:grab", { mateId: "", sourceId: "5", maxEdge: 1280, format: "png", quality: 85, hideAvatar: false }]);
  assert.deepEqual(calls[2], ["capture:setChoice", "mate_a", { id: "window:1:0", name: "A", kind: "window", display_id: "" }]);
  assert.deepEqual(calls[3], ["capture:request", { id: "cap_1", ask: true, nested: { a: 1 } }]);
  assert.deepEqual(calls[4], ["capture:cancel", "7"]);
  assert.equal(exposed.hrhCaptureAsk, undefined);
  const ask = loadPreload("capture-ask");
  ask.exposed.hrhCaptureAsk.answer("yes");
  ask.exposed.hrhCaptureAsk.answer(true);
  assert.deepEqual(ask.plain().slice(-2), [["capture:askAnswer", false], ["capture:askAnswer", true]]);
});
