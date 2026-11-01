# My Mate Geny desktop (Windows · macOS · Linux)

Electron shell around the live console of **your own** My Mate Geny server.
Design and features are the web app's own, so console updates reach the app
without reinstalling.

Native extras: persistent login, single instance, remembered window, native
notifications (via `window.hrhNative`), external links in the browser, offline
screen — and the **Mate** on the desktop (docs/mate.md §7).

## Connecting to a server

There is no built-in server. The first start shows a local connect screen
(`src/connect.html`): **Server address**, **Username**, **Password** (Show),
and *Remember the server and username* (the password is never stored).

- The address can be typed loosely: `example.com`, `example.com:8080`,
  `http://…`, `https://…/`, `192.168.0.10:58080`, `localhost:8080`,
  `[::1]:8080`, with spaces, uppercase, trailing slashes or a pasted console
  URL. `src/connect-core.js` normalizes it and probes `GET {server}/health`
  (5 s per try) for `{"status":"ok","service":"my-mate-geny"}`:
  - an explicit `http://` / `https://` is the only scheme tried;
  - no scheme: **https first, then http** — but **http first** for localhost,
    private / link-local / CGNAT IPs (`10.*`, `172.16–31.*`, `192.168.*`,
    `169.254.*`, `100.64–127.*`, `::1`, `fc00::/7`, `fe80::/10`),
    single-label and `.local`/`.lan`/`.home.arpa`/`.internal` names, and any
    explicit port other than 443;
  - a sub-path is kept (`example.com/geny` → `…/geny/health`), falling back
    to its parents (so a pasted `https://example.com/login` works);
  - redirects are followed and the final address is used (http → https).
- Errors are specific: *Can't reach the server*, *Not a My Mate Geny server*,
  *Wrong username or password*, *Too many attempts — try later*, certificate
  problems (*Can't connect securely — the server's certificate isn't
  trusted*: self-signed, expired or wrong name), and a too-old server.
- Sign-in runs in the main process (Electron `net`, no CORS):
  `POST {server}/api/auth/login {username, password, exchange: true}`, then
  the window loads `{server}/auth/exchange?code=…&next=/`, so the session
  cookie is set by the server itself, first-party; the console then loads as
  before.
- Next starts go straight to the saved server. When the session expires the
  server's own `/login` page appears, as in a browser.
- **Server → Switch server…** (menu, also in the tray) opens the connect
  screen prefilled; *Back* returns to the current server. **Server → Sign
  out** clears the server's cookies (and calls its `/api/auth/logout`) and
  shows the connect screen. Pages can call `window.hrhNative.switchServer()`
  / `window.hrhNative.signOut()` too (`changeServer()` is the old name).
- Not remembered: the server (and its cookies) is dropped at the next start.
- Upgrading from 0.3 (which fell back to the original author's server when no
  server was saved): an install still signed in there keeps using it; one
  that isn't sees it prefilled on the connect screen. Nothing else uses that
  address (`LEGACY_SERVER` in `src/settings.js`).

The Mate windows always load from the connected server, and the bridge only
answers pages of that origin; while no server is connected the Mate stays
hidden and the tray's Mate items open the connect screen.

## The Mate

The console window stays where you chat with worker sessions. The Mate lives
next to it:

- **Tray**: Open My Mate Geny · Show/Hide Mate · Quick chat (shows the
  shortcut) · Mate chat · Click-through · Move Mate · Keep Mate chat on top ·
  Start at login · Switch server… · Sign out · Quit.
- **Avatar window** (`/?surface=mate-overlay&mate=<id>`): transparent,
  frameless, no shadow, not in the taskbar, always on top (`screen-saver`
  level, re-asserted on focus/fullscreen/DPI changes), on all workspaces,
  click-through by default. Bottom-right by default; position remembered and
  clamped to a display that still exists; its size comes from the page
  (`setAvatarSize`, bottom-right corner fixed).
- **Hover action bar** (`src/bar.html`, local): appears while the pointer is
  on the avatar (cursor polled every 120 ms, hidden 450 ms after leaving):
  Chat · Quick · Click-through · Move · Hide · Console. Move mode makes the
  avatar take the mouse and the whole page drag the window until Done.
- **Quick chat** (`/?surface=mate-quick`): a transparent card near the top of
  the screen under the pointer, toggled by **Ctrl/Cmd+Shift+G** (configurable
  from the page via `setHotkey`; a taken shortcut is reported, the old one
  kept). Hides on blur and Esc. On GNOME Wayland the shortcut is a GNOME
  custom keybinding (`my-mate-geny-quick`) that the app watches.
- **Mate chat** (`/?surface=mate-chat`): a normal resizable window, optionally
  always on top.
- **Start at login** (`--hidden`: tray + Mate, no console window); Linux uses
  `~/.config/autostart/my-mate-geny.desktop`.
- Closing the console while the Mate is out hides it (the tray keeps the
  app); otherwise closing it quits as before. Quit (tray, menu, Cmd+Q) always
  quits. A fresh install opens the console as before; the Mate starts hidden.
- Microphone: `media` (audio) permission requests from the server's origin
  are granted (macOS asks once, `NSMicrophoneUsageDescription`); other
  permissions besides clipboard writes/fullscreen are refused.
- Linux runs as X11 (XWayland on Wayland) — a Wayland window cannot place
  itself. `HRH_OZONE_PLATFORM=wayland` opts out. Transparency needs a
  compositor. Repeated GPU crashes switch the next start to software
  rendering (`HRH_DISABLE_GPU=1` forces it).

Bridge for the pages: `window.hrhNative.mate` (see `src/preload.js`), every
call checked in the main process (sender window + top frame + server origin).
Settings (`serverUrl`, `lastServer`, `username`, `rememberConnect`, `mateId`, `mateBounds`, `mateClickThrough`, `mateVisible`,
`mateHotkey`, `mateAutostart`, `mateChatBounds`, `mateChatOnTop`) live in
`settings.json` next to the console's.

## Naming

Shown as **My Mate Geny**; internal ids are unchanged so existing installs
update in place and stay logged in: `appId` in `package.json` (Windows
notifications and installer identity), package name `hr-harnessor-desktop`
(Debian package), and the data folder (`…/hr-harnessor`, pinned in
`src/main.js` because Electron would otherwise derive it from the new
productName). On macOS the bundle is now `My Mate Geny.app`; an old
`hr-harnessor.app` can be deleted.

## Updates

The Download page of the console updates the app in place (`src/updater.js`,
electron-updater): check → download with progress (percent, speed, time left,
Cancel) → *Restart & install*; errors say why, with Retry. The state lives in
the main process, so a reloaded page shows the running download. The feed is
the connected server's `/api/downloads/update/` (it serves `latest.yml` /
`latest-linux.yml` and the installers from the `apps-latest` release, which CI
uploads alongside the installers). Windows (NSIS) and Linux AppImage replace
themselves, a .deb installs through a password prompt; unsigned macOS builds
cannot (the page offers the .dmg). A background check runs 30 s after start
and every 6 h (it only tells; downloading is the user's call). Help → *Check
for updates…*.

- A download first reads the feed again (the release is rolling: an hour-old
  "available" may name a build the server no longer has) and, on a 404 mid-way,
  once more.
- AppImage: electron-updater swaps the file (a versioned file name becomes the
  new version's name) and the restart is the app's own — the new file with the
  arguments the app was started with (`--no-sandbox`, which Ubuntu 24.04+ needs
  for AppImages), once the old process has exited. (electron-updater's own
  restart passed no arguments, so on those systems the new version aborted at
  start and the app did not come back — apps up to 0.4.16 do that once: start
  the app again by hand, it is already the new version.)
- A failed install (e.g. an AppImage in a folder you cannot write to) is an
  error with Retry, not a stuck "Installing…".
- Errors carry a code (`errorCode`) the console words in its language.

## Linux start-up (sandbox, .deb, logs)

Chromium sandboxes its renderers with unprivileged user namespaces, or else
with the SUID-root helper `chrome-sandbox`. With neither it aborts before any
app code runs (`FATAL:setuid_sandbox_host … The SUID sandbox helper binary was
found, but is not configured correctly`), so a launcher click showed nothing.
On Ubuntu 23.10+ (`kernel.apparmor_restrict_unprivileged_userns=1`) that hit:

- **every AppImage** started without `--no-sandbox` (a double-click passes no
  arguments; its chrome-sandbox is in a user-owned `nosuid` FUSE mount);
- **the .deb up to 0.4.18**: electron-builder's stock postinst made
  chrome-sandbox SUID only if `unshare --user true` failed — under AppArmor's
  restriction it succeeds (the namespace just gets no capabilities), so the
  helper stayed `0755` and every start aborted.

Now:

- `build/after-pack.js` renames the Electron binary to
  `hr-harnessor-desktop.bin` and puts `build/linux-launcher.sh` in its place,
  so the .deb's menu entry, `/usr/bin/hr-harnessor-desktop`, the AppImage's
  AppRun, start at login and the app's own restarts all go through it. It keeps
  the sandbox when chrome-sandbox is root-owned SUID (on a suid mount, no
  `no_new_privs`) or `unshare --user --map-root-user` works, or the .deb's
  AppArmor profile is there; otherwise it adds `--no-sandbox` (and says so on
  stderr). `HRH_SANDBOX=off|on` forces either way. Trade-off: without the
  sandbox the renderers run without the OS sandbox — acceptable here (only our
  local pages and the user's own server are loaded, with context isolation),
  and an app that starts beats one that silently doesn't.
- The .deb's postinst (`build/deb-postinst.tpl`) always makes chrome-sandbox
  `root:root 4755`, and on AppArmor 4 (Ubuntu 24.04+) installs
  `/etc/apparmor.d/hr-harnessor-desktop` (unconfined + `userns`, like the
  profiles Ubuntu ships for other Electron apps) for the real binary, so the
  installed app keeps its sandbox. `build/deb-postrm.tpl` removes the profile.
- The .deb depends on the 24.04 (`t64`) names with the old ones as
  alternatives (`libgtk-3-0t64 | libgtk-3-0`, `libasound2t64 | libasound2`, …).
- `<userData>/logs/main.log` (`~/.config/hr-harnessor/logs/main.log`) has each
  start (version, arguments, the launcher's sandbox decision), second launches
  and uncaught errors; a start that throws shows a dialog with the error and the
  log's path instead of exiting silently (`HRH_TEST_START_FAIL=1` makes one on
  purpose).
- A second launch while the app sits in the tray shows the console window.

## Build and test

- Dev: `npm install && npm start`
- Unit tests: `npm test` — the address normalizer, error mapping and the
  whole find → sign in → exchange flow against `test/mock-server.js` (a Node
  `http` server implementing the server contract; `node test/mock-server.js`
  runs it standalone).
- End-to-end on a built app (Linux, headless):
  `xvfb-run -a node test/e2e/electron-e2e.js dist/my-mate-geny-<v>-linux-x86_64.AppImage`
  (connect, errors, exchange + cookie, Mate window, relaunch, expired session,
  switch server, sign out, 0.3 migration; uses a throwaway HOME).
- A built Linux app started the way a desktop launcher does (no flags), on a
  throwaway X server and HOME: `test/e2e/launch-check.sh <out dir> <label>
  <secs> <AppImage | extracted deb's /opt/My Mate Geny/hr-harnessor-desktop>`
  (its output, the mapped windows, a screenshot; `SECOND=1
  FIRST_EXTRA=--hidden` also checks a second launch over a tray-only instance).
- In-app update of a packaged app (no `HRH_UPDATER_DEV`) against a server whose
  Download service reads the real `apps-latest`:
  `xvfb-run -a node test/e2e/update-e2e.js <server> <password> <shots dir> -- <older AppImage> [--full] [--readonly-install]`
  (Settings → Updates and the Download page; each updater request with its
  status and whether the session went along; Restart & install and the app the
  updater restarts; `--full`: a whole-file download through a slow proxy with a
  500 → Retry, a 404 → automatic re-check, reload and Cancel;
  `--readonly-install`: the install error and Retry). `-- <newest AppImage>
  --expect-latest`: the "up to date" state.
- The Android app's update flow in a browser (stand-in Capacitor bridge):
  `node test/e2e/apk-update-browser.js <server> <password> <app version>`.
- Builds: CI (`.github/workflows/apps.yml`) on every push touching `desktop/`,
  published to the `apps-latest` release and the console's Download page
  (`my-mate-geny-<version>-…`).
- Local Linux build: `npm run dist:linux` (or in `electronuserland/builder`).
- Unsigned: Windows SmartScreen and macOS Gatekeeper ask once (see the
  Download page); macOS builds are ad-hoc signed so Apple Silicon can run them.
