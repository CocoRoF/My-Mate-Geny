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
//
// What the real packaged apps taught (test/e2e/update-e2e.js, the server's access log):
// - the release is rolling: a check that found 0.4.14 an hour ago names a file the server no longer has (404) —
//   a download therefore looks at the feed again first, and a 404 mid-way looks once more and takes the newer build;
// - an AppImage restarted by electron-updater gets NO arguments, so the `--no-sandbox` it needs on Ubuntu 24.04+
//   (AppArmor restricts the user namespaces Chromium's sandbox wants) is gone and the new version aborts at start;
//   it also starts while the old app still holds the single-instance lock. The restart is ours instead (relaunch):
//   the same arguments, after this process has exited;
// - an install that fails (e.g. an AppImage in a folder the user cannot write to) is reported by an "error" event,
//   not by quitAndInstall: without listening the page sat on "Installing…" forever.
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
 *   restartAfter(file)? an AppImage's restart: start `file` with this app's arguments once this process has exited
 *   installFailed()? the install did not happen after all (beforeInstall undone)
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
    // an install that went wrong is only said here (quitAndInstall returns nothing; NSIS reports a failed start later)
    u.on("error", (e) => {
      if (state.status !== "installing") return;
      deps.installFailed?.(); // (the app stays: closing its window behaves as before again)
      set({ status: "error", error: describe(e, "install"), during: "install" });
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

  const describe = (e, during) => {
    const m = String(e?.message || e || "unknown error");
    if (/\b401\b|authentication required/i.test(m)) return "The server asked to sign in again.";
    if (/\b404\b/.test(m) && during === "download") return "The server no longer has that build (a newer one replaced it) — check again.";
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
      const found = await look();
      if (found) set({ status: "available", ...found, checkedAt: now() });
    } catch (e) {
      set({ status: "error", error: describe(e, "check"), during: "check", checkedAt: now() });
    }
    return view();
  }

  /** the feed, now: {version, total} when a newer build is there (electron-updater then holds it for download);
   *  otherwise the state says why (up to date, or this copy of the app cannot update itself) and null */
  async function look() {
    const u = await feed();
    const r = await u.checkForUpdates();
    if (r == null) {
      // electron-updater declined (not an AppImage / .deb / installer it knows — e.g. an unpacked folder)
      set({ status: "error", error: "This copy of the app cannot replace itself — install the new version from the Download page.", during: "check", checkedAt: now() });
      return null;
    }
    const version = r.updateInfo?.version;
    // (electron-updater keeps the update for downloadUpdate only when it says so itself)
    if (!version || r.isUpdateAvailable === false || compareVersions(version, deps.version) <= 0) {
      set({ status: "latest", version: version || deps.version, checkedAt: now() });
      return null;
    }
    return { version, total: sizeOf(r.updateInfo) };
  }

  async function download() {
    if (state.status === "downloading" || state.status === "ready" || state.status === "installing") return view();
    if (state.status !== "available") {
      await check();
      if (state.status !== "available") return view();
    }
    token = deps.cancelToken();
    const mine = token;
    speedSamples = [];
    set({ status: "downloading", percent: 0, transferred: 0, bytesPerSecond: 0, eta: null, error: undefined, cancelled: false });
    // the release is rolling: what an earlier check found may be gone — look at the feed again first, and once more
    // if the server no longer has the file (404) by the time it is asked for
    for (let attempt = 0; ; attempt++) {
      try {
        const found = await look();
        if (!found) return view(); // up to date after all (or cannot update): the state says so
        if (mine.cancelled) throw new Error("cancelled");
        set({ version: found.version, total: found.total || state.total });
        const u = await feed();
        await u.downloadUpdate(mine);
        if (state.status === "downloading") set({ status: "ready", percent: 100, eta: 0 }); // (no event on some paths)
        token = null;
        return view();
      } catch (e) {
        const cancelled = !!mine.cancelled || /cancel/i.test(String(e?.message || e));
        if (!cancelled && attempt === 0 && /\b404\b/.test(String(e?.message || e))) continue;
        token = null;
        if (cancelled) set({ status: "available", cancelled: true, percent: 0, bytesPerSecond: 0, eta: null });
        else set({ status: "error", error: describe(e, "download"), during: "download" });
        return view();
      }
    }
  }

  function cancel() {
    if (state.status === "downloading" && token) token.cancel();
    return view();
  }

  async function install() {
    if (state.status !== "ready") return view();
    set({ status: "installing", error: undefined });
    try {
      const u = await deps.autoUpdater();
      deps.beforeInstall?.();
      const env = deps.env || {};
      const appImage = deps.platform === "linux" && !!env.APPIMAGE;
      // Linux .deb: no silent / force-run (the relauncher's NoNewPrivs breaks the SUID sandbox — Project-Geny)
      const pkg = deps.platform === "linux" && !appImage;
      // AppImage: electron-updater swaps the file, then would start the new one itself — with no arguments and while
      // this app still runs; the restart is ours (the new file, this app's arguments, after this process exits)
      let spawn = null;
      if (appImage && deps.restartAfter && typeof u.spawnLog === "function") {
        spawn = u.spawnLog;
        u.spawnLog = async (file) => {
          deps.restartAfter(file);
          return true;
        };
      }
      try {
        u.quitAndInstall(!pkg, !pkg);
      } finally {
        if (spawn) u.spawnLog = spawn;
      }
    } catch (e) {
      set({ status: "error", error: describe(e, "install"), during: "install" });
    }
    return view();
  }

  /** a retry from the error state: whatever was attempted, again */
  async function retry() {
    const during = state.during;
    if (during === "install") {
      set({ status: "ready", error: undefined });
      return install();
    }
    set({ status: "idle", error: undefined });
    return during === "download" ? download() : check();
  }

  // refresh: say the state again (the language changed: the reason's words did)
  const refresh = () => deps.onState(view());
  return { get state() { return view(); }, check, download, cancel, install, retry, refresh, STATUS };
}

/** the arguments the restarted app gets: this one's own (`--no-sandbox`, `--ozone-platform=x11`, …) — never a hidden
 *  start (the user just pressed Restart & install) */
function restartArgs(argv) {
  return (argv || []).slice(1).filter((a) => a !== "--hidden");
}

/** a detached `sh` that waits for `pid` to end (the single-instance lock goes with it; at most ~30 s), then starts
 *  `file` with `args` */
function restartCommand(pid, file, args) {
  const script = 'n=0; while kill -0 "$1" 2>/dev/null && [ $n -lt 150 ]; do sleep 0.2; n=$((n+1)); done; shift; exec "$@"';
  return ["/bin/sh", ["-c", script, "sh", String(pid), file, ...args]];
}

function sizeOf(info) {
  const f = info?.files?.[0];
  return Number(f?.size) || 0;
}

module.exports = { createUpdater, compareVersions, support, restartArgs, restartCommand, STATUS };
