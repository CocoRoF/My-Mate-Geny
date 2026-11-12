// Screen capture for the Mate (docs/mate.md §4 "Seeing the screen"). The mate runs on the server; the screen is
// this computer's. Two ways in, both through the page's bridge (preload.js → window.hrhNative.capture):
//
// - the mate asks (its see_screen tool): the server sends a capture request to one of this app's pages over
//   /ws/sessions, the page calls request(): unless the mate may look without asking, a small prompt asks the user
//   ("‹mate› wants to see your screen" — the source, a preview, Allow once / Deny, a countdown that ends in Deny);
//   then the selected source is captured exactly as visible, without hiding/moving/refocusing app windows, and the
//   picture goes back to the page (which uploads it to the mate's conversation). Nothing is written to disk here.
// - the user shares (Share screen in the composer's + menu): sources() for the picker, grab() for the picture.
//
// What to capture is remembered per mate on this computer (settings.json `captureSources`): "" = the primary
// screen. A remembered window that is gone is never silently replaced by the whole screen — the prompt says so
// (and asks), and a mate allowed to look without asking gets nothing.
//
// All screens (device preference `screen.all_screens`, the page's pseudo source ALL_SCREENS): every screen is taken
// as its own picture, never stitched — the one the user works on (deps.activeDisplay: where the pointer moved last,
// cursor-feed.js) first as the main one, the others after it. Only a page that says it takes them all (`multi`: the
// server asked for them) gets them; otherwise — an older server — just the main one, in the usual one-picture shape.
"use strict";

// the bridge version the page reports to the server (app/mate/capture.py CAPTURE_BRIDGE; ≥ 4: all screens, MULTI_BRIDGE)
const CAPTURE_VERSION = 4;
const ASK = { w: 440, h: 430 };
const MAX_EDGES = new Set([0, 1280, 1920, 2560]);
const ALL_SCREENS = "screen:all";
const MAX_SCREENS = 6; // (the server takes at most this many pictures per capture: MAX_PICTURES)

const kindOf = (id) => (String(id || "").startsWith("screen:") ? "screen" : "window");

/** the size a picture of w×h gets with its long side at most maxEdge (0 = as it is); never upscaled */
function fitWithin(w, h, maxEdge) {
  const W = Math.max(1, Math.round(Number(w) || 1));
  const H = Math.max(1, Math.round(Number(h) || 1));
  const m = Number(maxEdge) || 0;
  if (!m || Math.max(W, H) <= m) return { width: W, height: H };
  const k = m / Math.max(W, H);
  return { width: Math.max(1, Math.round(W * k)), height: Math.max(1, Math.round(H * k)) };
}

/** a display's size in device pixels (what a full-resolution capture of it is) */
function displayPixels(d) {
  const s = Number(d && d.scaleFactor) || 1;
  const size = (d && d.size) || { width: 1920, height: 1080 };
  return { width: Math.round(size.width * s), height: Math.round(size.height * s) };
}

/**
 * Which source to capture. `pref`: what the user chose for this mate ({id, kind, name, display_id}) or null (the
 * primary screen). A screen whose id changed is found again by its display; a window whose id changed (its app
 * restarted) by its exact title when exactly one window has it. Otherwise → the primary screen with
 * `fallback: true` and `missing` = the choice that is gone (the caller decides whether that may be used).
 */
function resolveSource(sources, pref, primaryDisplayId) {
  const list = Array.isArray(sources) ? sources : [];
  const screens = list.filter((s) => kindOf(s.id) === "screen");
  const primary = screens.find((s) => s.display_id && String(s.display_id) === String(primaryDisplayId)) || screens[0] || null;
  if (!pref || !pref.id) return { source: primary, fallback: false, missing: null };
  const exact = list.find((s) => s.id === pref.id);
  if (exact) return { source: exact, fallback: false, missing: null };
  if ((pref.kind || kindOf(pref.id)) === "screen") {
    const same = pref.display_id ? screens.find((s) => String(s.display_id) === String(pref.display_id)) : null;
    if (same) return { source: same, fallback: false, missing: null };
  } else if (pref.name) {
    const named = list.filter((s) => kindOf(s.id) === "window" && s.name === pref.name);
    if (named.length === 1) return { source: named[0], fallback: false, missing: null };
  }
  return { source: primary, fallback: true, missing: pref };
}

/**
 * Every screen of an all-screens share, the main one first: the screen of `activeId` (the display in use), else the
 * primary one, else the first; the others left to right, top to bottom (`displays`: screen.getAllDisplays()).
 */
function orderScreens(sources, displays, activeId, primaryDisplayId) {
  const screens = (Array.isArray(sources) ? sources : []).filter((s) => s && s.id !== ALL_SCREENS && kindOf(s.id) === "screen");
  const on = (id) => (s) => !!s.display_id && !!id && String(s.display_id) === String(id);
  const main = screens.find(on(activeId)) || screens.find(on(primaryDisplayId)) || screens[0];
  if (!main) return [];
  const where = new Map((Array.isArray(displays) ? displays : []).map((d) => [String(d.id), d.bounds || {}]));
  const pos = (s) => where.get(String(s.display_id)) || {};
  const rest = screens.filter((s) => s !== main).map((s, i) => ({ s, i, x: pos(s).x, y: pos(s).y }));
  const num = (v) => (Number.isFinite(v) ? v : Infinity);
  rest.sort((a, b) => num(a.x) - num(b.x) || num(a.y) - num(b.y) || a.i - b.i);
  return [main, ...rest.map((r) => r.s)].slice(0, MAX_SCREENS);
}

/** a request from the page, made safe: the size in range (the picture is always a PNG) */
function cleanOptions(o = {}) {
  const edge = Number(o.maxEdge ?? o.max_edge);
  return {
    maxEdge: MAX_EDGES.has(edge) ? edge : 1920,
    hideAvatar: false, // legacy flags cannot hide, move or refocus any app window
  };
}

const describe = (s) => (s ? { id: s.id, name: String(s.name || ""), kind: kindOf(s.id), display_id: String(s.display_id || "") } : null);

/**
 * The capture service. deps: { desktopCapturer, screen, systemPreferences, shell?, readSettings, writeSettings,
 * platform, env (captures never change application window visibility),
 * ask: (info) => Promise<"allow"|"deny"|"timeout">, indicate: (state, info) => void, delay?: (ms) => Promise,
 * activeDisplay?: () => the id of the display in use (all screens: its picture is the main one) }
 */
function createCapture(d) {
  const platform = d.platform || process.platform;
  const env = d.env || process.env;
  const wayland = platform === "linux" && String(env.XDG_SESSION_TYPE || "").toLowerCase() === "wayland";
  let manualSequence = 0;
  let busy = null; // the request in progress (one at a time)
  const cancelled = new Set();

  function permission() {
    if (platform !== "darwin" || !d.systemPreferences || !d.systemPreferences.getMediaAccessStatus) return "granted";
    try {
      return d.systemPreferences.getMediaAccessStatus("screen") || "unknown";
    } catch {
      return "unknown";
    }
  }

  const info = () => ({ version: CAPTURE_VERSION, platform, wayland, permission: permission() });

  function primaryId() {
    try {
      return String(d.screen.getPrimaryDisplay().id);
    } catch {
      return "";
    }
  }

  function displayFor(src) {
    try {
      const all = d.screen.getAllDisplays();
      if (src && kindOf(src.id) === "screen") {
        const same = all.find((x) => String(x.id) === String(src.display_id));
        if (same) return same;
      }
      if (src && kindOf(src.id) === "window") {
        // (a window fits in the largest display; Electron keeps its aspect inside the box)
        return all.reduce((a, b) => (displayPixels(b).width * displayPixels(b).height > displayPixels(a).width * displayPixels(a).height ? b : a));
      }
      return d.screen.getPrimaryDisplay();
    } catch {
      return null;
    }
  }

  async function getSources(types, size) {
    return d.desktopCapturer.getSources({ types, thumbnailSize: size, fetchWindowIcons: false });
  }

  /** the sources for a picker: [{id, name, kind, display_id, thumbnail?}] (thumbnail: a small data URL) */
  async function sources({ thumbnails = false, size = 320 } = {}) {
    const box = thumbnails ? { width: Math.max(64, Math.min(640, size | 0)), height: Math.max(36, Math.min(400, Math.round(((size | 0) * 9) / 16))) } : { width: 1, height: 1 };
    const list = await getSources(["screen", "window"], box);
    const primary = primaryId();
    // (not our own see-through windows — the avatar, its bar, the quick card: nothing to look at)
    const own = new Set((d.ownSourceIds && d.ownSourceIds()) || []);
    return list
      .filter((s) => s && s.id && !own.has(s.id))
      .map((s) => ({
        ...describe(s),
        primary: kindOf(s.id) === "screen" && String(s.display_id) === primary,
        ...(thumbnails && s.thumbnail && !s.thumbnail.isEmpty() ? { thumbnail: s.thumbnail.toDataURL() } : {}),
      }));
  }

  const appPrefs = () => d.preferences ? d.preferences.get().screen : null;
  const options = o => { const p=appPrefs();return cleanOptions(p ? { ...o, maxEdge:p.max_edge,hideAvatar:p.hide_avatar,hide_avatar:p.hide_avatar } : o); };
  const prefs = () => {
    const all = (d.readSettings() || {}).captureSources;
    return all && typeof all === "object" ? all : {};
  };
  const validMate = (id) => (typeof id === "string" && /^[\w.:-]{1,100}$/.test(id) ? id : null);
  const ALL = { id: ALL_SCREENS, name: "", kind: "screen", display_id: "" };

  /** the source chosen for a mate on this computer (null: the primary screen; ALL_SCREENS: every screen) */
  function getChoice(mateId) {
    if (d.preferences) return appPrefs().all_screens ? ALL : appPrefs().source;
    const id = validMate(mateId);
    const p = id ? prefs()[id] : null;
    return p && typeof p === "object" && typeof p.id === "string" ? p : null;
  }

  function setChoice(mateId, src) {
    if (d.preferences) {
      d.preferences.patch({ screen: src && src.id === ALL_SCREENS ? { source: null, all_screens: true } : { source: src, all_screens: false } });
      return true;
    }
    const id = validMate(mateId);
    if (!id) return false;
    const next = { ...prefs() };
    if (!src || !src.id) delete next[id];
    else next[id] = { id: String(src.id).slice(0, 200), name: String(src.name || "").slice(0, 200), kind: kindOf(src.id), display_id: String(src.display_id || "").slice(0, 40) };
    d.writeSettings({ captureSources: next });
    return true;
  }

  /** one picture of `source` (a {id, kind, display_id} resolved just now) */
  async function shoot(source, o) {
    const display = displayFor(source);
    const full = display ? displayPixels(display) : { width: 1920, height: 1080 };
    const box = fitWithin(full.width, full.height, o.maxEdge);
    const list = await getSources([kindOf(source.id)], box);
    const hit = list.find((s) => s.id === source.id);
    const img = hit && hit.thumbnail;
    if (!img || img.isEmpty()) return null;
    let size = img.getSize();
    let out = img;
    const fit = fitWithin(size.width, size.height, o.maxEdge);
    if (fit.width !== size.width || fit.height !== size.height) {
      out = img.resize({ width: fit.width, height: fit.height, quality: "best" });
      size = out.getSize();
    }
    return { data: out.toPNG(), mime: "image/png", width: size.width, height: size.height, source: describe(hit) };
  }

  /**
   * The pictures of `r` (resolve()): its source — or, all screens and a page that takes them (`multi`), every screen,
   * each at its own size, main first ([] when the main one failed; another screen that came back empty is left out).
   */
  async function shootAll(r, o, id, multi) {
    const list = multi && r.screens ? r.screens : [r.source];
    const shots = [];
    for (const [i, src] of list.entries()) {
      if (cancelled.has(id)) break;
      const shot = await shoot(src, o);
      if (!shot && !i) return [];
      if (shot) shots.push({ ...shot, role: i ? "sub" : "main" });
    }
    return shots;
  }
  // (the main picture in the one-picture shape every page knows; `shots`: all of them, main first, for a page that
  // takes them)
  const answer = (shots, multi) => {
    const { role, ...main } = shots[0];
    return { ok: true, ...main, ...(multi ? { shots } : {}) };
  };

  const fail = (code, message = "") => ({ ok: false, code, message });
  const noPicture = () => fail(wayland ? "empty" : platform === "darwin" && permission() !== "granted" ? "permission" : "empty");

  function activeId() {
    try {
      return d.activeDisplay ? String(d.activeDisplay() || "") : "";
    } catch {
      return "";
    }
  }

  async function resolve(mateId, sourceId) {
    if (platform === "darwin" && permission() === "denied") return { error: fail("permission") };
    let list;
    try {
      list = await getSources(["screen", "window"], { width: 1, height: 1 });
    } catch (e) {
      return { error: fail(wayland ? "empty" : "error", String((e && e.message) || e)) };
    }
    if (!list || !list.length) return { error: fail(wayland ? "empty" : platform === "darwin" ? "permission" : "empty") };
    const pref = sourceId ? { id: sourceId, kind: kindOf(sourceId) } : getChoice(mateId);
    if (pref && pref.id === ALL_SCREENS) {
      let displays = [];
      try {
        displays = d.screen.getAllDisplays();
      } catch {
        /* headless */
      }
      const screens = orderScreens(list, displays, activeId(), primaryId());
      if (!screens.length) return { error: fail("empty") };
      return { source: screens[0], screens, fallback: false, missing: null };
    }
    const r = resolveSource(list, pref, primaryId());
    if (!r.source) return { error: fail("empty") };
    return r;
  }

  /**
   * the user's own capture (Share screen): {ok, data, mime, width, height, source, shots?} | {ok: false, code}
   * (o.multi: the page takes every screen of an all-screens share — `shots`, main first)
   */
  async function grab(o = {}) {
    if (busy) return fail("busy");
    const opts = options(o);
    const id = String(o.id || `grab_${++manualSequence}`);
    const multi = o.multi === true;
    busy = { id };
    try {
      if (d.preferences && o.sourceId && (o.sourceId === ALL_SCREENS ? !appPrefs().all_screens : appPrefs().source?.id !== o.sourceId)) return fail("source_gone");
      const r = await resolve(o.mateId, typeof o.sourceId === "string" ? o.sourceId : "");
      if (r.error) return r.error;
      if(cancelled.has(id))return fail("stopped");
      if (r.fallback && o.sourceId) return fail("source_gone");
      d.indicate && d.indicate("start", {mateName:"Geny"});
      const shots = await shootAll(r, opts, id, multi);
      if(cancelled.has(id))return fail("stopped");
      if (!shots.length) return noPicture();
      d.indicate && d.indicate("done",{id,mateName:"Geny",source:shots[0].source,count:shots.length});
      return answer(shots, multi);
    } catch (e) {
      return fail("error", String((e && e.message) || e));
    } finally {
      d.indicate && d.indicate("idle",{});
      busy = null; cancelled.delete(id);
    }
  }

  /**
   * The mate asked to see the screen (a capture.request from the server, handed over by the page):
   * {id, mate_id, mate_name, ask, hide_avatar, max_edge, format, quality, timeout_ms, reason, multi?}
   * → {ok: true, data, mime, width, height, source, shots?} | {ok: false, code: denied|timeout|busy|permission|empty|source_gone|error}
   * (multi: the server takes every screen of an all-screens share; asking once covers them all)
   */
  async function request(req = {}) {
    const id = String(req.id || "");
    if (!id) return fail("error", "no request id");
    if (busy) return fail("busy");
    let opts = options(req);
    const multi = req.multi === true;
    busy = { id };
    const mateName = String(req.mate_name || "").slice(0, 80) || "Mate";
    try {
      const r = await resolve(req.mate_id, "");
      if (r.error) return r.error;
      if(cancelled.has(id))return fail("stopped");
      if ((d.preferences || String(req.mate_id || "").startsWith("session:")) && r.fallback && r.missing) return fail("source_gone");
      const ask = appPrefs() ? !req.automatic && appPrefs().approval === "ask" : req.ask !== false;
      if (ask) {
        let preview = "";
        try {
          const small = await getSources([kindOf(r.source.id)], { width: 360, height: 220 });
          const hit = small.find((s) => s.id === r.source.id);
          if (hit && hit.thumbnail && !hit.thumbnail.isEmpty()) preview = hit.thumbnail.toDataURL();
        } catch {
          /* no preview */
        }
        const said = await d.ask({
          id, mateName, reason: String(req.reason || "").slice(0, 300), source: describe(r.source), preview,
          screens: multi && r.screens ? r.screens.length : 1,
          missing: r.fallback ? r.missing : null, hideAvatar: opts.hideAvatar, timeoutMs: Math.max(5000, Math.min(120000, Number(req.timeout_ms) || 45000)),
        });
        if (cancelled.has(id)) return fail("stopped");
        if (said !== "allow") return fail(said === "timeout" ? "timeout" : said === "stopped" ? "stopped" : "denied");
      } else if (r.fallback && r.missing && r.missing.kind === "window") {
        // allowed to look without asking — but only at what the user chose: never the whole screen instead
        return fail("source_gone");
      }
      opts = options(req);
      d.indicate && d.indicate("start", { mateName });
      const shots = await shootAll(r, opts, id, multi);
      if(cancelled.has(id))return fail("stopped");
      if (!shots.length) {
        d.indicate && d.indicate("error", { mateName });
        return noPicture();
      }
      d.indicate && d.indicate("done", { id,mateName, source: shots[0].source, count: shots.length });
      return answer(shots, multi);
    } catch (e) {
      return fail("error", String((e && e.message) || e));
    } finally {
      if(cancelled.has(id)) d.indicate && d.indicate("idle",{});
      busy = null;
      cancelled.delete(id);
    }
  }

  /** the server gave up on a request (timeout, the turn ended): its prompt goes away, nothing is captured */
  function cancel(id) {
    if (busy && (id === "*" || busy.id === String(id))) {
      cancelled.add(busy.id);
      d.cancelAsk && d.cancelAsk(busy.id);
      d.indicate && d.indicate("idle",{});
    }
  }

  return { info, sources, getChoice, setChoice, grab, request, cancel, permission, busy:()=>!!busy };
}

// ── the approval prompt (a small window of our own: capture-ask.html) ─────────

/**
 * deps: { BrowserWindow, screen, ipcMain, preload, file, t, version } → { ask(info) → Promise<answer>, cancel(id) }
 * One prompt at a time; it answers "timeout" when its countdown ends, "deny" when closed.
 */
function createAsker(d) {
  let current = null; // { id, win, info, resolve }

  function finish(answer) {
    const c = current;
    if (!c) return;
    current = null;
    clearTimeout(c.timer);
    try {
      if (!c.win.isDestroyed()) c.win.destroy();
    } catch {
      /* gone */
    }
    c.resolve(answer);
  }

  const fromAsk = (e) => !!current && !current.win.isDestroyed() && e.sender === current.win.webContents && String((e.senderFrame && e.senderFrame.url) || "").startsWith("file:");
  d.ipcMain.handle("capture:askInfo", (e) => (fromAsk(e) ? { ...current.info, deadline: current.deadline } : null));
  d.ipcMain.on("capture:askAnswer", (e, allow) => {
    if (fromAsk(e)) finish(allow === true ? "allow" : "deny");
  });

  function ask(info) {
    if (current) return Promise.resolve("deny");
    return new Promise((resolve) => {
      let area = { x: 0, y: 0, width: 1280, height: 800 };
      try {
        area = d.screen.getDisplayNearestPoint(d.screen.getCursorScreenPoint()).workArea;
      } catch {
        /* headless */
      }
      const win = new d.BrowserWindow({
        width: ASK.w, height: ASK.h, x: Math.round(area.x + (area.width - ASK.w) / 2), y: Math.round(area.y + (area.height - ASK.h) / 3),
        frame: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: false,
        alwaysOnTop: true, show: false, title: d.t ? d.t("captureAskTitle", { name: info.mateName }) : "Screen sharing",
        backgroundColor: "#00000000", transparent: false,
        webPreferences: { preload: d.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false,
          additionalArguments: [`--hrh-version=${d.version || "0.0.0"}`, "--hrh-surface=capture-ask"] },
      });
      const deadline = Date.now() + info.timeoutMs;
      current = { id: info.id, win, info, resolve, deadline, timer: setTimeout(() => finish("timeout"), info.timeoutMs) };
      win.setAlwaysOnTop(true, "screen-saver");
      win.once("ready-to-show", () => {
        if (!win.isDestroyed()) {
          win.show();
          win.focus();
        }
      });
      win.on("closed", () => current && current.win === win && finish("deny"));
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (e) => e.preventDefault());
      win.loadFile(d.file).catch(() => finish("deny"));
    });
  }

  function cancel(id) {
    if (current && current.id === id) finish("stopped");
  }

  return { ask, cancel, isOpen: () => !!current };
}

module.exports = { CAPTURE_VERSION, ALL_SCREENS, MAX_SCREENS, kindOf, fitWithin, displayPixels, resolveSource, orderScreens, cleanOptions, createCapture, createAsker };
