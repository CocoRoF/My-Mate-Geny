// In-app updates (Project-Geny's updater.ts, adapted): the Download page shows the progress of a new desktop build
// (percent, speed, time left), then Restart & install. The state lives here in the main process — a page that
// reloads (or another window) reads it again and follows it — and every path ends somewhere definite: up to date,
// ready, unsupported (with what to do instead) or an error with its reason, and Retry.
//
//   idle → checking → latest | available → downloading (percent, bytes/s, ETA; Cancel) → ready → installing
//                              ↘ error (Retry)                    ↘ cancelled → available
//
// The feed is the connected server (`{server}/api/downloads/update/`, backend/app/routers/downloads.py), which
// serves electron-builder's latest.yml / latest-linux.yml and the installers from the rolling `apps-latest`
// release (fetched server-side: the release needs a token). The requests carry the session cookie.
//
// Platforms: Windows (NSIS) and Linux AppImage replace themselves; Linux .deb installs through a privilege prompt
// (electron-updater's DebUpdater); macOS builds are unsigned, which Squirrel.Mac refuses — there the page offers the
// new .dmg instead. A development run (`electron .`) does not update unless HRH_UPDATER_DEV=1 (tests).
"use strict";

const STATUS = ["idle", "checking", "latest", "available", "downloading", "ready", "installing", "unsupported", "error"];

/** semver-ish compare of dotted versions: -1 / 0 / 1 */
function compareVersions(a, b) {
  const pa = String(a || "").split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "").split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** what this install can do (`code`: the reason's message in i18n.js — the console shows it in the UI's language) */
function support({ isPackaged, platform, env = {}, server }) {
  if (!isPackaged && env.HRH_UPDATER_DEV !== "1") return { ok: false, code: "updDev", reason: "A development build does not update itself." };
  if (platform === "darwin") return { ok: false, code: "updMac", reason: "macOS builds are not signed, so they cannot replace themselves — download the new .dmg below." };
  if (platform !== "win32" && platform !== "linux") return { ok: false, code: "updOs", reason: "Updates are not available on this system." };
  if (!server) return { ok: false, code: "updServer", reason: "Not connected to a server." };
  return { ok: true, how: platform === "win32" ? "installer" : env.APPIMAGE ? "appimage" : "deb" };
}

/**
 * deps: {
 *   autoUpdater()   → electron-updater's autoUpdater (lazy), CancellationToken class via cancelToken()
 *   version, platform, isPackaged, env, server(), cookieHeader(): Promise<string>,
 *   onState(state), beforeInstall(), now(), reasonText(code)? (the "can't update here" reason in the UI's language)
 * }
 */
function createUpdater(deps) {
  const now = deps.now || Date.now;
  let state = { status: "idle", current: deps.version };
  let wired = false;
  let token = null;
  let speedSamples = [];

  const view = () => {
    const s = support({ isPackaged: deps.isPackaged, platform: deps.platform, env: deps.env || {}, server: deps.server() });
    const reason = s.ok ? undefined : (deps.reasonText && deps.reasonText(s.code)) || s.reason;
    return { ...state, current: deps.version, supported: s.ok, how: s.how || null, reason };
  };
  const set = (patch, replace = false) => {
    state = replace ? { ...patch } : { ...state, ...patch };
    deps.onState(view());
  };

  function wire(u) {
    if (wired) return;
    wired = true;
    u.autoDownload = false;
    u.autoInstallOnAppQuit = true; // downloaded but not restarted yet: installed when the app quits
    u.disableDifferentialDownload = true; // a full download: honest progress, no range requests through the proxy
    u.allowDowngrade = false;
    u.logger = null;
    if (!deps.isPackaged) {
      // a development run (tests): electron-updater wants an app-update.yml for its cache folder
      u.forceDevUpdateConfig = true;
      if (deps.devConfigPath) u.updateConfigPath = deps.devConfigPath();
    }
    u.on("download-progress", (p) => {
      if (state.status !== "downloading") return;
      const t = now();
      speedSamples = [...speedSamples.filter((x) => t - x.t < 4000), { t, bytes: p.transferred }];
      const first = speedSamples[0];
      const measured = speedSamples.length > 1 && t > first.t ? ((p.transferred - first.bytes) * 1000) / (t - first.t) : 0;
      const bps = Math.round(p.bytesPerSecond || measured || 0);
      set({
        percent: Math.max(0, Math.min(100, Number(p.percent) || 0)),
        transferred: p.transferred || 0,
        total: p.total || state.total || 0,
        bytesPerSecond: bps,
        eta: bps > 0 && p.total ? Math.max(0, Math.round((p.total - p.transferred) / bps)) : null,
      });
    });
    u.on("update-downloaded", (info) => {
      token = null;
      set({ status: "ready", version: info?.version || state.version, percent: 100, eta: 0 });
    });
  }

  let feedSet = "";
  async function feed() {
    const u = await deps.autoUpdater();
    wire(u);
    // (only when it changes: setFeedURL forgets the update a check found — "Please check update first")
    const url = deps.feedUrl ? deps.feedUrl() : `${deps.server()}/api/downloads/update`;
    if (url !== feedSet) {
      u.setFeedURL({ provider: "generic", url });
      feedSet = url;
    }
    const cookie = await deps.cookieHeader().catch(() => "");
    u.requestHeaders = cookie ? { Cookie: cookie } : {};
    return u;
  }

  const describe = (e) => {
    const m = String(e?.message || e || "unknown error");
    if (/\b401\b|authentication required/i.test(m)) return "The server asked to sign in again.";
    if (/\b404\b/.test(m)) return "The server has no update for this system yet.";
    if (/\b5\d\d\b/.test(m)) return `The server could not provide the update (${(m.match(/\b5\d\d\b[^"\n]*/) || [""])[0].trim()}).`;
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ERR_INTERNET|net::/i.test(m)) return `Can't reach the server (${m.split("\n")[0].slice(0, 120)}).`;
    if (/sha512|checksum/i.test(m)) return "The download was damaged (checksum mismatch) — try again.";
    return m.split("\n")[0].slice(0, 200);
  };

  async function check() {
    const s = view();
    if (!s.supported) {
      set({ status: "unsupported" });
      return view();
    }
    if (["checking", "downloading", "installing"].includes(state.status)) return view();
    if (state.status === "ready") return view();
    set({ status: "checking", error: undefined });
    try {
      const u = await feed();
      const r = await u.checkForUpdates();
      const version = r?.updateInfo?.version;
      // (electron-updater keeps the update for downloadUpdate only when it says so itself)
      if (!version || r.isUpdateAvailable === false || compareVersions(version, deps.version) <= 0) set({ status: "latest", version: version || deps.version, checkedAt: now() });
      else set({ status: "available", version, total: sizeOf(r.updateInfo), checkedAt: now() });
    } catch (e) {
      set({ status: "error", error: describe(e), during: "check", checkedAt: now() });
    }
    return view();
  }

  async function download() {
    if (state.status === "downloading" || state.status === "ready" || state.status === "installing") return view();
    if (state.status !== "available") {
      await check();
      if (state.status !== "available") return view();
    }
    try {
      const u = await feed();
      token = deps.cancelToken();
      speedSamples = [];
      set({ status: "downloading", percent: 0, transferred: 0, bytesPerSecond: 0, eta: null, error: undefined, cancelled: false });
      await u.downloadUpdate(token);
      if (state.status === "downloading") set({ status: "ready", percent: 100, eta: 0 }); // (no event on some paths)
    } catch (e) {
      const cancelled = !!token?.cancelled || /cancel/i.test(String(e?.message || e));
      token = null;
      if (cancelled) set({ status: "available", cancelled: true, percent: 0, bytesPerSecond: 0, eta: null });
      else set({ status: "error", error: describe(e), during: "download" });
    }
    return view();
  }

  function cancel() {
    if (state.status === "downloading" && token) token.cancel();
    return view();
  }

  async function install() {
    if (state.status !== "ready") return view();
    set({ status: "installing" });
    try {
      const u = await deps.autoUpdater();
      deps.beforeInstall?.();
      // Linux .deb: no silent / force-run (the relauncher's NoNewPrivs breaks the SUID sandbox — Project-Geny)
      const pkg = deps.platform === "linux" && !(deps.env || {}).APPIMAGE;
      u.quitAndInstall(!pkg, !pkg);
    } catch (e) {
      set({ status: "error", error: describe(e), during: "install" });
    }
    return view();
  }

  /** a retry from the error state: whatever was attempted, again */
  async function retry() {
    const during = state.during;
    set({ status: "idle", error: undefined });
    return during === "download" ? download() : check();
  }

  // refresh: say the state again (the language changed: the reason's words did)
  const refresh = () => deps.onState(view());
  return { get state() { return view(); }, check, download, cancel, install, retry, refresh, STATUS };
}

function sizeOf(info) {
  const f = info?.files?.[0];
  return Number(f?.size) || 0;
}

module.exports = { createUpdater, compareVersions, support, STATUS };
