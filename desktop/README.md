# hr-harnessor desktop (Windows · macOS · Linux)

Electron shell around the live console (`https://agent.hrletsgo.me` by default,
Help → Change server… to point it elsewhere). Design and features are the web
app's own, so console updates reach the app without reinstalling.

Native extras: persistent login, single instance, remembered window, native
notifications (via `window.hrhNative`), external links in the browser, offline
screen.

- Dev: `npm install && npm start`
- Builds: CI (`.github/workflows/apps.yml`) on every push touching `desktop/`,
  published to the `apps-latest` release and the console's Download page.
- Local Linux build: `npm run dist:linux` (or in `electronuserland/builder`).
- Unsigned: Windows SmartScreen and macOS Gatekeeper ask once (see the
  Download page); macOS builds are ad-hoc signed so Apple Silicon can run them.
