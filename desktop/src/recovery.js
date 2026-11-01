// A window never stays black (docs/mate.md §7): when its page cannot be loaded (did-fail-load), its renderer dies
// (render-process-gone), hangs (unresponsive) or loaded but draws nothing (an empty #root — e.g. an older web
// console whose code chunk vanished in a deploy), the window shows the local retry page (offline.html) which retries
// by itself with a growing delay (2 s, 4 s, 8 s … 60 s) and has a Retry button.
//
// The logic is plain (no electron import) so it is unit-tested with a fake window and fake timers
// (test/recovery.test.js).
"use strict";

const MAX_DELAY = 60_000;
/** a page that stayed up this long counts as recovered: the next failure starts the backoff over */
const STABLE_MS = 30_000;
/** how long a renderer may hang before the retry page replaces it */
const UNRESPONSIVE_GRACE = 8_000;
/** how often an opened page is checked for "loaded but blank", and how many empty looks in a row count */
const BLANK_EVERY = 4_000;
const BLANK_LOOKS = 2;

/** The delay before the n-th automatic retry (n = 0, 1, 2 …). */
function retryDelay(attempt) {
  const n = Math.max(0, Math.floor(Number(attempt) || 0));
  return Math.min(MAX_DELAY, 2000 * 2 ** Math.min(n, 10));
}

/** did-fail-load events that are not a failure of the page: subframes, and -3 (aborted: replaced by another load). */
function isRealLoadFailure(code, isMainFrame) {
  return !!isMainFrame && Number(code) !== -3;
}

const REASON = {
  offline: "offline",
  crashed: "crashed",
  unresponsive: "unresponsive",
  blank: "blank",
};

/**
 * The retry state of one window.
 *   show({ reason, error, attempt, delay }) — put the retry page up
 *   now / setTimeout / clearTimeout — injectable for tests
 */
function createRecovery({ show, now = Date.now, setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout, graceMs = UNRESPONSIVE_GRACE } = {}) {
  let attempt = 0;
  let loadedAt = 0;
  let hangTimer = null;
  let onRetryPage = false;

  const fire = (reason, error = "") => {
    if (loadedAt && now() - loadedAt >= STABLE_MS) attempt = 0;
    loadedAt = 0;
    ct(hangTimer);
    hangTimer = null;
    const info = { reason, error: String(error || ""), attempt, delay: retryDelay(attempt) };
    attempt += 1;
    onRetryPage = true;
    show(info);
    return info;
  };

  return {
    get attempt() {
      return attempt;
    },
    get showing() {
      return onRetryPage;
    },
    /** did-fail-load */
    failLoad(code, desc, isMainFrame) {
      if (!isRealLoadFailure(code, isMainFrame)) return null;
      return fire(REASON.offline, desc || `error ${code}`);
    },
    /** render-process-gone */
    gone(details = {}) {
      if (details.reason === "clean-exit") return null;
      return fire(REASON.crashed, details.reason || "crashed");
    },
    /** BrowserWindow 'unresponsive': give it a moment, then replace the page */
    unresponsive() {
      if (hangTimer) return;
      hangTimer = st(() => {
        hangTimer = null;
        fire(REASON.unresponsive, "not responding");
      }, graceMs);
    },
    responsive() {
      ct(hangTimer);
      hangTimer = null;
    },
    /** the page drew nothing (checked by the caller) */
    blank() {
      return fire(REASON.blank, "the page drew nothing");
    },
    /** a page of the server finished loading (the retry page itself does not count) */
    loaded() {
      loadedAt = now();
      onRetryPage = false;
    },
    dispose() {
      ct(hangTimer);
      hangTimer = null;
    },
  };
}

/**
 * Wire a window: events → recovery → the retry page.
 *   kind       — "console" | "chat" | "quick" (the retry page's look and its Retry target)
 *   isAppUrl   — a URL of the connected server
 *   retryPage  — absolute path of offline.html
 *   server()   — the server URL (shown on the page)
 *   watchBlank — check a loaded page for an empty #root (console, chat)
 */
function attach(win, { kind, isAppUrl, retryPage, server = () => "", watchBlank = false, timers = {} } = {}) {
  const wc = win.webContents;
  const st = timers.setTimeout || setTimeout;
  const ct = timers.clearTimeout || clearTimeout;
  const si = timers.setInterval || setInterval;
  const ci = timers.clearInterval || clearInterval;
  let blankTimer = null;
  let empties = 0;

  const stopWatch = () => {
    ci(blankTimer);
    blankTimer = null;
    empties = 0;
  };
  const rec = createRecovery({
    setTimeout: st,
    clearTimeout: ct,
    now: timers.now || Date.now,
    show: ({ reason, error, attempt, delay }) => {
      stopWatch();
      if (win.isDestroyed()) return;
      win.loadFile(retryPage, { query: { kind, reason, server: server() || "", error, attempt: String(attempt), delay: String(delay) } }).catch(() => {});
    },
  });

  const look = async () => {
    if (win.isDestroyed() || !win.isVisible() || wc.isLoading() || !isAppUrl(wc.getURL())) return;
    let n;
    try {
      n = await Promise.race([
        wc.executeJavaScript(`(() => { const r = document.getElementById("root"); return r ? r.childElementCount : -1; })()`, false),
        new Promise((resolve) => st(() => resolve(null), 3000)),
      ]);
    } catch {
      n = null;
    }
    if (n === 0) {
      empties += 1;
      if (empties >= BLANK_LOOKS) rec.blank();
    } else if (n !== null) empties = 0;
  };

  wc.on("did-fail-load", (_e, code, desc, _url, isMainFrame) => {
    rec.failLoad(code, desc, isMainFrame);
  });
  wc.on("render-process-gone", (_e, details) => {
    rec.gone(details);
  });
  win.on("unresponsive", () => rec.unresponsive());
  win.on("responsive", () => rec.responsive());
  wc.on("did-start-loading", stopWatch);
  wc.on("did-finish-load", () => {
    if (!isAppUrl(wc.getURL())) return;
    rec.loaded();
    if (watchBlank && !blankTimer) blankTimer = si(look, BLANK_EVERY);
  });
  win.on("closed", () => {
    stopWatch();
    rec.dispose();
  });
  return rec;
}

module.exports = { retryDelay, isRealLoadFailure, createRecovery, attach, REASON, STABLE_MS, UNRESPONSIVE_GRACE, BLANK_EVERY, BLANK_LOOKS };
