// Screen capture for the Mate (src/capture.js, docs/mate.md §4 "Seeing the screen"): the size a picture gets, which
// source is captured (and when a remembered one is gone), the mate's request (ask → allow / deny / no answer, the
// avatar windows hidden and shown again, allowed without asking), the user's own grab, all screens (one picture per
// screen, the one in use first; only the main one for an older server) and the preload bridge.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { fitWithin, displayPixels, resolveSource, orderScreens, cleanOptions, createCapture, kindOf, ALL_SCREENS } = require("../src/capture");

test("fitWithin: the long side at most maxEdge, never upscaled, 0 = as it is", () => {
  assert.deepEqual(fitWithin(3840, 2160, 1920), { width: 1920, height: 1080 });
  assert.deepEqual(fitWithin(1080, 2400, 1280), { width: 576, height: 1280 });
  assert.deepEqual(fitWithin(800, 600, 1920), { width: 800, height: 600 });
  assert.deepEqual(fitWithin(5120, 2880, 0), { width: 5120, height: 2880 });
  assert.deepEqual(fitWithin(0, -3, 100), { width: 1, height: 1 });
  assert.deepEqual(displayPixels({ size: { width: 1440, height: 900 }, scaleFactor: 2 }), { width: 2880, height: 1800 });
  assert.deepEqual(displayPixels({ size: { width: 1920, height: 1080 } }), { width: 1920, height: 1080 });
});

test("cleanOptions: sizes from the page are checked; the picture is always a PNG", () => {
  assert.deepEqual(cleanOptions({ max_edge: 2560, format: "jpeg", quality: 12, hide_avatar: false }), { maxEdge: 2560, hideAvatar: false });
  assert.deepEqual(cleanOptions({ maxEdge: 99999, format: "gif" }), { maxEdge: 1920, hideAvatar: false });
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

test("request: captures the primary screen without hiding or showing any app window", async () => {
  const { cap, log } = rig();
  const r = await cap.request(REQ);
  assert.equal(r.ok, true);
  assert.equal(r.mime, "image/png");
  assert.deepEqual([r.width, r.height], [1920, 1080]); // 3840×2160 device pixels → 1920
  assert.equal(String(r.data), "PNG 1920x1080");
  assert.deepEqual(r.source, { id: "screen:0:0", name: "Screen 1", kind: "screen", display_id: "11" });
  const steps = log.map((x) => x[0]);
  assert.deepEqual(steps, ["getSources", "getSources", "ask", "indicate", "getSources", "indicate"]);
  assert.deepEqual(log.find((x) => x[0] === "ask"), ["ask", "Estelle", "screen:0:0", true, null]);
  assert.deepEqual(log[4], ["getSources", "screen", "1920x1080"]); // only screens, at the capture size
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
  assert.equal(String(r.data), "PNG 3840x2160");
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
  assert.ok(!log.some((x) => ["hide","show"].includes(x[0])));
  assert.equal((await cap.grab({ sourceId: "window:404:0" })).code, "source_gone");
  const list = await cap.sources({ thumbnails: true, size: 320 });
  assert.deepEqual(list.map((s) => s.id), ["screen:1:0", "screen:0:0", "window:77:0", "window:89:0"]); // (not our own windows)
  assert.equal(list.find((s) => s.id === "screen:0:0").primary, true);
  assert.ok(list.every((s) => s.thumbnail.startsWith("data:image/png")));
  assert.deepEqual(cap.info(), { version: 4, platform: "linux", wayland: false, permission: "granted" });
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
  assert.equal(cap.version, 4);
  await cap.sources({ thumbnails: 1, size: "320" });
  await cap.grab({ sourceId: 5, maxEdge: "1280", format: "bmp", hideAvatar: false, extra: "x" });
  await cap.setChoice("mate_a", { id: "window:1:0", name: "A", kind: "window", evil: () => 1 });
  await cap.request({ id: "cap_1", ask: true, nested: { a: 1 }, multi: true });
  await cap.cancel(7);
  await cap.grab({ sourceId: ALL_SCREENS, multi: true });
  await cap.grab({ multi: "yes" });
  const calls = plain();
  assert.deepEqual(calls[0], ["capture:sources", { thumbnails: true, size: 320 }]);
  assert.deepEqual(calls[1], ["capture:grab", { id:"", mateId: "", sourceId: "5", maxEdge: 1280, hideAvatar: false, hideConsole: false, multi: false }]);
  assert.deepEqual(calls[2], ["capture:setChoice", "mate_a", { id: "window:1:0", name: "A", kind: "window", display_id: "" }]);
  assert.deepEqual(calls[3], ["capture:request", { id: "cap_1", ask: true, nested: { a: 1 }, multi: true }]);
  assert.deepEqual(calls[4], ["capture:cancel", "7"]);
  assert.deepEqual(calls[5], ["capture:grab", { id:"", mateId: "", sourceId: ALL_SCREENS, maxEdge: 0, hideAvatar: false, hideConsole: false, multi: true }]);
  assert.equal(calls[6][1].multi, false); // (only a real true)
  assert.equal(exposed.hrhCaptureAsk, undefined);
  const ask = loadPreload("capture-ask");
  ask.exposed.hrhCaptureAsk.answer("yes");
  ask.exposed.hrhCaptureAsk.answer(true);
  assert.deepEqual(ask.plain().slice(-2), [["capture:askAnswer", false], ["capture:askAnswer", true]]);
});


test("session sharing never replaces a missing selected screen or window", async () => {
  const { cap, log } = rig();
  for (const src of [{ id: "screen:gone:0", kind: "screen", display_id: "gone" }, { id: "window:gone:0", kind: "window", name: "gone" }]) {
    cap.setChoice("session:sess_test", src);
    const res = await cap.request({ id: `req-${src.kind}`, mate_id: "session:sess_test", ask: true });
    assert.equal(res.ok, false);
    assert.equal(res.code, "source_gone");
  }
});


test('cancel during native capture never changes window visibility and discards late bytes', async () => {
  let release, entered;
  const begun = new Promise(r => entered = r);
  const { cap, log } = rig({ deps: { desktopCapturer: { getSources: async ({types,thumbnailSize}) => {
    if(thumbnailSize.width>640){entered();await new Promise(r=>release=r);}
    return SOURCES.filter(s=>types.includes(kindOf(s.id))).map(s=>({...s,thumbnail:image(thumbnailSize.width,thumbnailSize.height)}));
  } } } });
  const request=cap.request({...REQ,id:'cancel-late',ask:false});
  await begun;cap.cancel('cancel-late');
  assert.ok(!log.some(x=>['hide','show'].includes(x[0])),'no app window should be hidden or restored');
  release();const result=await request;assert.equal(result.ok,false);assert.equal(result.code,'stopped');
});

test('app settings override stale per-mate capture request options', async () => {
  let screen={source:SOURCES[1],approval:'allow',max_edge:1280,format:'jpeg',quality:70,hide_avatar:false};
  const {cap,log}=rig({deps:{preferences:{get:()=>({screen}),patch:p=>{screen={...screen,...p.screen};}}}});
  const shot=await cap.request({...REQ,ask:true,max_edge:2560,format:'png',hide_avatar:true});
  assert.equal(shot.mime,'image/png');assert.equal(String(shot.data),'PNG 1280x720');assert.ok(!log.some(x=>x[0]==='ask'));assert.ok(!log.some(x=>x[0]==='hide'));
  cap.setChoice('different-mate',SOURCES[0]);assert.equal(cap.getChoice('another-mate').id,SOURCES[0].id);
});

test("legacy hide options never hide or restore windows across repeated captures",async()=>{
 const {cap,log}=rig();
 for(let i=0;i<3;i++)assert.equal((await cap.grab({sourceId:'screen:0:0',hideAvatar:true,hideConsole:true})).ok,true);
 assert.ok(!log.some(x=>['hide','show'].includes(x[0])));
});

// ── all screens: one picture per screen, the one in use first ──

test("orderScreens: the display in use first, else the primary, else the first; the others left to right", () => {
  const displays = [{ id: 11, bounds: { x: 0, y: 0 } }, { id: 22, bounds: { x: 2560, y: 0 } }, { id: 33, bounds: { x: -1920, y: 0 } }];
  const list = [
    { id: "screen:0:0", display_id: "11" }, { id: "screen:1:0", display_id: "22" }, { id: "window:7:0", name: "W" },
    { id: "screen:2:0", display_id: "33" }, { id: ALL_SCREENS },
  ];
  const ids = (a) => a.map((s) => s.id);
  assert.deepEqual(ids(orderScreens(list, displays, "22", "11")), ["screen:1:0", "screen:2:0", "screen:0:0"]);
  assert.deepEqual(ids(orderScreens(list, displays, "", "11")), ["screen:0:0", "screen:2:0", "screen:1:0"]);
  assert.deepEqual(ids(orderScreens(list, displays, "99", "")), ["screen:0:0", "screen:2:0", "screen:1:0"]);
  // (no display ids — some Linux setups: the first screen is the main one, the rest in the system's order)
  assert.deepEqual(ids(orderScreens([{ id: "screen:5:0" }, { id: "screen:6:0" }], [], "22", "11")), ["screen:5:0", "screen:6:0"]);
  assert.deepEqual(orderScreens([], displays, "11", "11"), []);
  const many = Array.from({ length: 9 }, (_, i) => ({ id: `screen:${i}:0`, display_id: String(i) }));
  assert.equal(orderScreens(many, [], "3", "0").length, 6);
});

function allScreens(over = {}) {
  let screen = { source: null, all_screens: true, approval: "ask", max_edge: 0, ...over.screen };
  const asked = [];
  const preferences = { get: () => ({ screen }), patch: (p) => { screen = { ...screen, ...p.screen }; } };
  const r = rig({ ...over, deps: { preferences, activeDisplay: () => "22", ask: async (info) => (asked.push(info), over.answer || "allow"), ...over.deps } });
  return { ...r, asked, screen: () => screen };
}
const shotsOf = (r) => r.shots.map((s) => [s.role, s.source.id, `${s.width}x${s.height}`]);
const pictureCalls = (log) => log.filter((x) => x[0] === "getSources" && x[1] === "screen" && x[2] !== "360x220" && x[2] !== "0x0");

test("all screens, a server that takes them: every screen its own picture, the one in use first, asked once", async () => {
  const { cap, log, asked } = allScreens();
  const r = await cap.request({ ...REQ, multi: true });
  assert.equal(r.ok, true);
  // display 22 is in use: its screen is the main picture; display 11 (3840×2160 device pixels) at its own size
  assert.deepEqual(shotsOf(r), [["main", "screen:1:0", "1920x1080"], ["sub", "screen:0:0", "3840x2160"]]);
  assert.ok(r.shots.every((s) => s.mime === "image/png" && String(s.data) === `PNG ${s.width}x${s.height}`));
  // the one-picture shape is the main one (what an older page reads)
  assert.equal(r.source.id, "screen:1:0");
  assert.equal(String(r.data), "PNG 1920x1080");
  assert.equal(r.role, undefined);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].screens, 2);
  assert.equal(asked[0].source.id, "screen:1:0"); // (the preview: the main one)
  assert.deepEqual(log.filter((x) => x[0] === "indicate").map((x) => x[1]), ["start", "done"]);
  // max_edge applies to each picture
  const small = allScreens({ screen: { max_edge: 1280 } });
  assert.deepEqual(shotsOf(await small.cap.request({ ...REQ, multi: true })), [["main", "screen:1:0", "1280x720"], ["sub", "screen:0:0", "1280x720"]]);
  // nobody in use (no pointer): the primary display's screen is the main one
  const idle = allScreens({ deps: { activeDisplay: () => "" } });
  assert.deepEqual(shotsOf(await idle.cap.request({ ...REQ, multi: true })).map((s) => s[1]), ["screen:0:0", "screen:1:0"]);
  // denied: nothing at all
  const no = allScreens({ answer: "deny" });
  assert.equal((await no.cap.request({ ...REQ, multi: true })).code, "denied");
  assert.equal(pictureCalls(no.log).length, 0);
});

test("all screens, an older server (no multi): only the main picture, in the one-picture shape", async () => {
  const { cap, log, asked } = allScreens();
  const r = await cap.request(REQ);
  assert.equal(r.ok, true);
  assert.equal(r.shots, undefined);
  assert.equal(r.source.id, "screen:1:0");
  assert.equal(asked[0].screens, 1);
  assert.equal(pictureCalls(log).length, 1);
  // allowed without asking (the device setting): no prompt, still every screen when the server takes them
  const quiet = allScreens({ screen: { approval: "allow" } });
  assert.equal((await quiet.cap.request({ ...REQ, multi: true })).shots.length, 2);
  assert.equal(quiet.asked.length, 0);
});

test("all screens: an empty other screen is left out; an empty main one is a failed capture", async () => {
  const blank = (id) => ({ desktopCapturer: { getSources: async ({ types, thumbnailSize }) => SOURCES.filter((s) => types.includes(kindOf(s.id))).map((s) => ({
    ...s, thumbnail: s.id === id && thumbnailSize.width > 400 ? image(0, 0, { empty: true }) : image(thumbnailSize.width, Math.round((thumbnailSize.width * 9) / 16)),
  })) } });
  const sub = allScreens({ deps: blank("screen:0:0") });
  assert.deepEqual(shotsOf(await sub.cap.request({ ...REQ, multi: true })), [["main", "screen:1:0", "1920x1080"]]);
  const main = allScreens({ deps: blank("screen:1:0") });
  assert.deepEqual(await main.cap.request({ ...REQ, multi: true }), { ok: false, code: "empty", message: "" });
});

test("all screens: cancelled between two pictures → nothing is delivered", async () => {
  let release, entered;
  const second = new Promise((r) => (entered = r));
  let pictures = 0;
  const { cap } = allScreens({ screen: { approval: "allow" }, deps: { desktopCapturer: { getSources: async ({ types, thumbnailSize }) => {
    if (thumbnailSize.width > 640 && ++pictures === 2) { entered(); await new Promise((r) => (release = r)); }
    return SOURCES.filter((s) => types.includes(kindOf(s.id))).map((s) => ({ ...s, thumbnail: image(thumbnailSize.width, thumbnailSize.height) }));
  } } } });
  const req = cap.request({ ...REQ, id: "cap_all", multi: true });
  await second;
  cap.cancel("cap_all");
  release();
  assert.deepEqual(await req, { ok: false, code: "stopped", message: "" });
});

test("all screens: the user's own grab, the choice it is saved as, and the per-mate fallback", async () => {
  const { cap, screen } = allScreens();
  const r = await cap.grab({ sourceId: ALL_SCREENS, multi: true });
  assert.deepEqual(shotsOf(r).map((s) => s.slice(0, 2)), [["main", "screen:1:0"], ["sub", "screen:0:0"]]);
  assert.equal((await cap.grab({ sourceId: ALL_SCREENS })).shots, undefined); // (an older page: the main one)
  assert.deepEqual(cap.getChoice("x"), { id: ALL_SCREENS, name: "", kind: "screen", display_id: "" });
  cap.setChoice("x", SOURCES[2]);
  assert.equal(screen().all_screens, false);
  assert.equal(screen().source.id, "window:77:0");
  assert.equal((await cap.grab({ sourceId: ALL_SCREENS, multi: true })).code, "source_gone"); // (not the choice any more)
  cap.setChoice("x", { id: ALL_SCREENS, name: "All", kind: "screen" });
  assert.deepEqual([screen().all_screens, screen().source], [true, null]);
  // without device preferences (older settings): remembered per mate like any source
  const old = rig({ deps: { activeDisplay: () => "11" } });
  old.cap.setChoice("mate_a", { id: ALL_SCREENS, name: "" });
  assert.deepEqual(shotsOf(await old.cap.request({ ...REQ, ask: false, multi: true })).map((s) => s[1]), ["screen:0:0", "screen:1:0"]);
  // one display only: one picture, main
  const one = allScreens({ deps: { screen: { getPrimaryDisplay: () => ({ id: 11 }), getAllDisplays: () => [{ id: 11 }] },
    desktopCapturer: { getSources: async ({ types, thumbnailSize }) => SOURCES.filter((s) => s.id === "screen:0:0" && types.includes("screen")).map((s) => ({ ...s, thumbnail: image(thumbnailSize.width, thumbnailSize.height) })) } } });
  assert.deepEqual(shotsOf(await one.cap.grab({ sourceId: ALL_SCREENS, multi: true })).map((s) => s.slice(0, 2)), [["main", "screen:0:0"]]);
});

// ── light on the main process (png.js: the mouse on Windows waits for it) ──

test("a list asks for no thumbnails (0×0: nothing captured) and only the kinds it needs", async () => {
  const { cap, log } = rig();
  assert.equal((await cap.request({ ...REQ, ask: false })).ok, true);
  assert.deepEqual(log[0], ["getSources", "screen", "0x0"]); // (the primary screen: no windows)
  const win = rig();
  win.cap.setChoice("mate_a", { id: "window:77:0", name: "Terminal — build" });
  assert.equal((await win.cap.request({ ...REQ, ask: false })).ok, true);
  assert.deepEqual(win.log[0], ["getSources", "screen,window", "0x0"]); // (a chosen window: windows too)
  const picker = rig();
  await picker.cap.sources();
  assert.deepEqual(picker.log[0], ["getSources", "screen,window", "0x0"]);
  // a Wayland desktop's portal keeps the list it had
  const wl = rig({ deps: { env: { XDG_SESSION_TYPE: "wayland" } } });
  await wl.cap.grab({});
  assert.deepEqual(wl.log[0], ["getSources", "screen", "1x1"]);
});

test("all screens: screens of the same size come from one capture; each picture is encoded off the main thread, one after another", async () => {
  const encoded = [];
  let open = 0;
  const encodePng = async (img) => {
    assert.equal(open++, 0, "one picture at a time");
    await new Promise((r) => setTimeout(r, 5));
    encoded.push(`${img.w}x${img.h}`);
    open--;
    return Buffer.from(`ENC ${img.w}x${img.h}`);
  };
  // max_edge 1280: both screens (3840×2160 and 1920×1080 device pixels) are 1280×720 pictures
  const same = allScreens({ screen: { approval: "allow", max_edge: 1280 }, deps: { encodePng } });
  const r = await same.cap.request({ ...REQ, multi: true });
  assert.deepEqual(shotsOf(r), [["main", "screen:1:0", "1280x720"], ["sub", "screen:0:0", "1280x720"]]);
  assert.equal(pictureCalls(same.log).length, 1, "one capture for both");
  assert.deepEqual(encoded, ["1280x720", "1280x720"]);
  assert.ok(r.shots.every((s) => String(s.data) === "ENC 1280x720"));
  // their own sizes (max_edge 0): one capture per size
  const own = allScreens({ screen: { approval: "allow" }, deps: { encodePng } });
  assert.deepEqual(shotsOf(await own.cap.request({ ...REQ, multi: true })).map((s) => s[2]), ["1920x1080", "3840x2160"]);
  assert.deepEqual(pictureCalls(own.log).map((x) => x[2]), ["1920x1080", "3840x2160"]);
  // the default encoder: a picture that is no plain bitmap (these fakes) is NativeImage.toPNG(), as before
  assert.equal(String((await rig().cap.request({ ...REQ, ask: false })).data), "PNG 1920x1080");
});
