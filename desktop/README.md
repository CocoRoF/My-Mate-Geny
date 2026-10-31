# My Mate Geny desktop (Windows · macOS · Linux)

Electron shell around the live console (`https://agent.hrletsgo.me` by default,
Help → Change server… or the tray to point it elsewhere). Design and features
are the web app's own, so console updates reach the app without reinstalling.

Native extras: persistent login, single instance, remembered window, native
notifications (via `window.hrhNative`), external links in the browser, offline
screen — and the **Mate** on the desktop (docs/mate.md §7).

## The Mate

The console window stays where you chat with worker sessions. The Mate lives
next to it:

- **Tray**: Open My Mate Geny · Show/Hide Mate · Quick chat (shows the
  shortcut) · Mate chat · Click-through · Move Mate · Keep Mate chat on top ·
  Start at login · Change server… · Quit.
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
Settings (`mateId`, `mateBounds`, `mateClickThrough`, `mateVisible`,
`mateHotkey`, `mateAutostart`, `mateChatBounds`, `mateChatOnTop`) live in
`settings.json` next to the console's.

## Naming

Shown as **My Mate Geny**; internal ids are unchanged so existing installs
update in place and stay logged in: appId `me.hrletsgo.harnessor` (Windows
notifications and installer identity), package name `hr-harnessor-desktop`
(Debian package), and the data folder (`…/hr-harnessor`, pinned in
`src/main.js` because Electron would otherwise derive it from the new
productName). On macOS the bundle is now `My Mate Geny.app`; an old
`hr-harnessor.app` can be deleted.

## Build

- Dev: `npm install && npm start`
- Builds: CI (`.github/workflows/apps.yml`) on every push touching `desktop/`,
  published to the `apps-latest` release and the console's Download page
  (`my-mate-geny-<version>-…`).
- Local Linux build: `npm run dist:linux` (or in `electronuserland/builder`).
- Unsigned: Windows SmartScreen and macOS Gatekeeper ask once (see the
  Download page); macOS builds are ad-hoc signed so Apple Silicon can run them.
