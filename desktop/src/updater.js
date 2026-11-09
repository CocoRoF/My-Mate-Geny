// In-app updates (Project-Geny's updater.ts, adapted): the Download page shows the progress of a new desktop build
// (percent, speed, time left), then installs it and the app restarts in the new version. The state lives here in the
// main process — a page that reloads (or another window) reads it again and follows it — and every path ends
// somewhere definite: up to date, ready, unsupported (with what to do instead) or an error with its reason, and Retry.
//
//   idle → checking → latest | available → downloading (percent, bytes/s, ETA; Cancel) → ready → installing
//                              ↘ error (Retry)                    ↘ cancelled → available
//
// The native update-source module reads the selected GitHub repository and serves a capability-protected
// loopback feed. It works in Local and Server modes without a Geny server or Geny cookies. Private source
// credentials remain on this device; signed asset redirects never receive the GitHub authorization header.
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
//   not by quitAndInstall: without listening the page sat on "Installing…" forever;
// - Windows: "Download & install" stopped at "ready" and wanted a second press, and electron-updater quits the app on
//   the next turn after asking for the installer, whether it started or not. A download now goes straight on to the
//   install; the app's own processes (the local backend and the engines it runs, all from the app's folder) are
//   stopped and waited for first, and the app quits once the installer is running — a failed start keeps the app
//   and says why, with Retry.
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
function support({ isPackaged, platform, env = {}, server, macSigned = false }) {
  if (!isPackaged && env.HRH_UPDATER_DEV !== "1") return { ok: false, code: "updDev", reason: "A development build does not update itself." };
  // (Squirrel.Mac only takes a signed app from a signed app: a build made without the release's certificate can't)
  if (platform === "darwin" && !macSigned) return { ok: false, code: "updMac", reason: "This macOS build is not signed, so it cannot replace itself — download the new .dmg below." };
  if (platform !== "win32" && platform !== "linux" && platform !== "darwin") return { ok: false, code: "updOs", reason: "Updates are not available on this system." };
  if (!server) return { ok: false, code: "updServer", reason: "Not connected to a server." };
  return { ok: true, how: platform === "win32" ? "installer" : platform === "darwin" ? "mac" : env.APPIMAGE ? "appimage" : "deb" };
}

/**
 * deps: {
 *   autoUpdater()   → electron-updater's autoUpdater (lazy), CancellationToken class via cancelToken()
 *   version, platform, isPackaged, env, server(), cookieHeader(): Promise<string>, macSigned (the release's certificate),
 *   onState(state), beforeInstall(): Promise? (the app quitting for real, its own processes stopped), now(),
 *   reasonText(code)? (the "can't update here" reason in the UI's language)
 *   quit() the app quits for the installer (which is running by then)
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
  let shuttingDown = false;
  let instance = null;

  const view = () => {
    const s = support({ isPackaged: deps.isPackaged, platform: deps.platform, env: deps.env || {}, server: deps.server(), macSigned: deps.macSigned });
    const reason = s.ok ? undefined : (deps.reasonText && deps.reasonText(s.code)) || s.reason;
    return { ...state, current: deps.version, supported: s.ok, how: s.how || null, reason };
  };
  const set = (patch, replace = false) => {
    if(shuttingDown)return;
    state = replace ? { ...patch } : { ...state, ...patch };
    deps.onState(view());
  };

  function wire(u) {
    instance=u;
    if(shuttingDown){u.autoInstallOnAppQuit=false;u.autoRunAppAfterInstall=false;return;}
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
      if(shuttingDown)return;
      if (state.status !== "installing") return;
      deps.installFailed?.(); // (the app stays: closing its window behaves as before again)
      set({ status: "error", ...failure(e, "install"), during: "install" });
    });
  }

  let feedSet = "";
  async function feed() {
    if(shuttingDown)throw Error("App is quitting");
    const u = await deps.autoUpdater();
    wire(u);
    if(shuttingDown)throw Error("App is quitting");
    // (only when it changes: setFeedURL forgets the update a check found — "Please check update first")
    const url = deps.feedUrl ? await deps.feedUrl() : `${deps.server()}/api/downloads/update`;
    if (url !== feedSet) {
      u.setFeedURL({ provider: "generic", url });
      feedSet = url;
    }
    const cookie = await deps.cookieHeader().catch(() => "");
    if(shuttingDown)throw Error("App is quitting");
    u.requestHeaders = cookie ? { Cookie: cookie } : {};
    return u;
  }

  // what went wrong: `error` in English (logs, older consoles), `errorCode` + `errorDetail` for the console to say it
  // in the UI's language (downloads.updErr.<code> in frontend/src/i18n)
  const failure = (e, during) => {
    if(/^source(Access|Credential|RateLimit|Unavailable|Invalid|Changed)$/.test(e?.code||''))return {errorCode:e.code,error:e.code,errorDetail:''};
    const m = String(e?.message || e || "unknown error");
    const first = m.split("\n")[0];
    const out = (errorCode, error, errorDetail = "") => ({ errorCode, error, errorDetail });
    if (/\b401\b|authentication required/i.test(m)) return out("signIn", "The server asked to sign in again.");
    if (/\b404\b/.test(m) && during === "download") return out("replaced", "The server no longer has that build (a newer one replaced it) — check again.");
    if (/\b404\b/.test(m)) return out("noUpdate", "The server has no update for this system yet.");
    if (/\b5\d\d\b/.test(m)) {
      const d = (m.match(/\b5\d\d\b[^"\n]*/) || [""])[0].trim();
      return out("server", `The server could not provide the update (${d}).`, d);
    }
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ERR_INTERNET|net::/i.test(m)) return out("unreachable", `Can't reach the server (${first.slice(0, 120)}).`, first.slice(0, 120));
    if (/sha512|checksum/i.test(m)) return out("damaged", "The download was damaged (checksum mismatch) — try again.");
    return out("other", first.slice(0, 200), first.slice(0, 200));
  };
  const SELF = { errorCode: "cannotSelfUpdate", error: "This copy of the app cannot replace itself — install the new version from the Download page.", errorDetail: "" };
  const NO_ERROR = { error: undefined, errorCode: undefined, errorDetail: undefined };

  async function check() {
    if(shuttingDown)return view();
    const s = view();
    if (!s.supported) {
      set({ status: "unsupported" });
      return view();
    }
    if (["checking", "downloading", "installing"].includes(state.status)) return view();
    if (state.status === "ready") return view();
    set({ status: "checking", ...NO_ERROR });
    try {
      const found = await look();
      if (found) set({ status: "available", ...found, checkedAt: now() });
    } catch (e) {
      set({ status: "error", ...failure(e, "check"), during: "check", checkedAt: now() });
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
      set({ status: "error", ...SELF, during: "check", checkedAt: now() });
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
    if(shuttingDown)return view();
    if (state.status === "downloading" || state.status === "ready" || state.status === "installing") return view();
    if (state.status !== "available") {
      await check();
      if (state.status !== "available") return view();
    }
    token = deps.cancelToken();
    const mine = token;
    speedSamples = [];
    set({ status: "downloading", percent: 0, transferred: 0, bytesPerSecond: 0, eta: null, ...NO_ERROR, cancelled: false });
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
        // "Download & install" is one step: the update is here, so it goes in now (the app restarts in the new version)
        return state.status === "ready" ? install() : view();
      } catch (e) {
        const cancelled = !!mine.cancelled || /cancel/i.test(String(e?.message || e));
        if (!cancelled && attempt === 0 && /\b404\b/.test(String(e?.message || e))) continue;
        token = null;
        if (cancelled) set({ status: "available", cancelled: true, percent: 0, bytesPerSecond: 0, eta: null });
        else set({ status: "error", ...failure(e, "download"), during: "download" });
        return view();
      }
    }
  }

  function cancel() {
    if (state.status === "downloading" && token) token.cancel();
    return view();
  }

  async function install() {
    if(shuttingDown)return view();
    if (state.status !== "ready") return view();
    set({ status: "installing", ...NO_ERROR });
    try {
      const u = await deps.autoUpdater();
      if(shuttingDown)return view();
      // what runs from the app's folder ends first, waited for: the installer replaces those files
      await deps.beforeInstall?.();
      if(shuttingDown)return view();
      const env = deps.env || {};
      const appImage = deps.platform === "linux" && !!env.APPIMAGE;
      // Linux .deb: no silent / force-run (the relauncher's NoNewPrivs breaks the SUID sandbox — Project-Geny)
      const pkg = deps.platform === "linux" && !appImage;
      // (macOS: Squirrel.Mac installs as the app quits, and quitAndInstall quits once it has the update)
      if (typeof u.install !== "function") {
        u.quitAndInstall(!pkg, !pkg);
        return view();
      }
      // Windows: the installer shows its progress, then starts the app (build/installer.nsh) — a silent one left a
      // minute with nothing on screen, long enough to open the app again over the files being replaced.
      // AppImage: electron-updater swaps the file, then would start the new one itself — with no arguments and while
      // this app still runs; the restart is ours (the new file, this app's arguments, after this process exits)
      const silent = !pkg && deps.platform !== "win32";
      await runInstaller(u, silent, !pkg, appImage && deps.restartAfter ? deps.restartAfter : null);
      if (state.status !== "installing") return view(); // (the "error" event said why)
      deps.quit();
    } catch (e) {
      if (state.status === "installing") {
        deps.installFailed?.();
        set({ status: "error", ...failure(e, "install"), during: "install" });
      }
    }
    return view();
  }

  /** electron-updater's install, resolved once the installer is running: the first start, or the one electron-updater
   *  tries after it (elevate.exe when Windows refused); a .deb installs synchronously, with nothing to start */
  async function runInstaller(u, silent, run, restart) {
    const own = u.spawnLog;
    const starts = [];
    u.spawnLog = function (file, ...rest) {
      const p = restart ? Promise.resolve().then(() => (restart(file), true)) : own.call(this, file, ...rest);
      starts.push(p);
      return p;
    };
    try {
      if (!u.install(silent, run)) throw new Error("The installer could not be started.");
      let last = null;
      for (let seen = 0; seen < starts.length; ) {
        const batch = starts.slice(seen);
        seen = starts.length;
        try {
          await Promise.any(batch);
          return;
        } catch (e) {
          last = e.errors?.at(-1) || e;
        }
        await new Promise((r) => setTimeout(r, 300)); // (electron-updater's next try, if it has one, starts now)
      }
      if (last) throw last;
    } catch (e) {
      u.quitAndInstallCalled = false; // (electron-updater's guard against a second start: Retry must be able to)
      throw e;
    } finally {
      u.spawnLog = own;
    }
  }

  /** a retry from the error state: whatever was attempted, again */
  async function retry() {
    const during = state.during;
    if (during === "install") {
      set({ status: "ready", ...NO_ERROR });
      return install();
    }
    set({ status: "idle", ...NO_ERROR });
    return during === "download" ? download() : check();
  }

  // refresh: say the state again (the language changed: the reason's words did)
  const refresh = () => deps.onState(view());
  function shutdown(){
    if(shuttingDown)return;
    shuttingDown=true;
    if(instance){instance.autoInstallOnAppQuit=false;instance.autoRunAppAfterInstall=false;}
    token?.cancel();token=null;
  }
  function reset(){if(shuttingDown||['checking','downloading','ready','installing'].includes(state.status))return false;set({status:'idle',current:deps.version},true);return true;}
  return { get state() { return view(); }, check, download, cancel, install, retry, refresh, shutdown, reset, STATUS };
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
