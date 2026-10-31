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
- Builds: CI (`.github/workflows/apps.yml`) on every push touching `desktop/`,
  published to the `apps-latest` release and the console's Download page
  (`my-mate-geny-<version>-…`).
- Local Linux build: `npm run dist:linux` (or in `electronuserland/builder`).
- Unsigned: Windows SmartScreen and macOS Gatekeeper ask once (see the
  Download page); macOS builds are ad-hoc signed so Apple Silicon can run them.
